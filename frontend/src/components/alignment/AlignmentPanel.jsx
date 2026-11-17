import { useState, useEffect, useRef, useMemo } from 'react'
import {
  getAlignmentBlocks, saveAlignmentTest,
  runAlignmentComparison, getAlignmentTests, getAlignmentTest, getCurrentDraftTest,
  generateThemeSample, generateSingleOutputTest,
} from '../../api'
import socket from '../../socket'
import BlockSelector from './BlockSelector'
import SampleGenerator from './SampleGenerator'
import HumanLabelingPanel from './HumanLabelingPanel'
import ThemeMatchLabelingPanel from './ThemeMatchLabelingPanel'
import SingleOutputComparisonPanel from './SingleOutputComparisonPanel'
import ComparisonResults from './ComparisonResults'
import TestHistory from './TestHistory'
import ConfirmDialog from '../common/ConfirmDialog'
import { BlockPromptsPanel, TemplatesPanel } from './LivePromptsPanel'
import { usePromptSync } from '../../store/promptSync'
import OptimizationPanel from './optimizer/OptimizationPanel'
import ParallelSlotsNote from './ParallelSlotsNote'

const AUTOSAVE_DEBOUNCE_MS = 1500

function comparisonModeFor(block) {
  return block?.comparison_mode
    || (block?.block_type === 'themeIdent' ? 'per_unit_theme_match'
      : (block?.block_type === 'categoryBuild' || block?.block_type === 'customPrompt') ? 'single_output'
        : 'per_unit')
}

// Compares what the user asked for against what was actually available, so a
// too-small candidate pool (e.g. most cells blank on a split column, or just
// a small document) shows up as an explicit notice rather than silently
// sampling fewer cases than requested. Works from either a fresh
// generate-sample response or a restored draft test (both carry
// sample_size/requested_sample_size — older drafts predating this field
// simply won't show a warning).
function shortfallWarning(data) {
  const requested = data?.requested_sample_size
  const actual = data?.sample_size ?? data?.sample_units?.length
  if (requested == null || actual == null || actual >= requested) return null
  return `Only ${actual} of the ${requested} requested cases were available and sampled — there weren't enough valid cases to fill the full request.`
}

// Mirrors NodeExpandedPanel's ColumnGranularityControl / ColumnCellBrowser's
// describeMethod wording, so the same setting reads identically everywhere.
function granularityDescription(block) {
  const data = block?.data || {}
  if (!data.sentence_column) return null
  const method = data.sentence_split_method || 'sentence'
  const delimiters = data.sentence_split_delimiters
    || (data.sentence_split_delimiter ? [data.sentence_split_delimiter] : [])
  const delimList = delimiters.map(d => `"${d}"`).join(', ')
  const methodText = method === 'both'
    ? `sentence boundaries + delimiters ${delimList}`
    : method === 'delimiter'
      ? `delimiters ${delimList}`
      : 'sentence boundaries'
  return { column: data.sentence_column, methodText }
}

export default function AlignmentPanel({ projectId, isActive, onShowConsole }) {
  // Block selection
  const [selectedBlock, setSelectedBlock] = useState(null)
  const [selectedBlockId, setSelectedBlockId] = useState(null)
  const [restoringDraft, setRestoringDraft] = useState(false)
  const [sampleSizeWarning, setSampleSizeWarning] = useState(null)

  // Sample + test state (per_unit / per_unit_theme_match)
  const [sampleUnits, setSampleUnits] = useState([])
  const [themeReferenceList, setThemeReferenceList] = useState([])
  const [currentTestId, setCurrentTestId] = useState(null)
  const [activeTestData, setActiveTestData] = useState(null)
  const [humanLabels, setHumanLabels] = useState({})

  // single_output state (categoryBuild / customPrompt)
  const [contextText, setContextText] = useState('')
  const [humanExpected, setHumanExpected] = useState('')
  const [humanRationale, setHumanRationale] = useState('')
  // Bumped when rationales are saved from outside the labeling rows (optimizer's
  // "Explain disagreements"), so the rows remount with the new text instead of
  // later writing their stale copy back.
  const [labelsVersion, setLabelsVersion] = useState(0)
  // Opt-in Throughput mode for comparison runs (1 = one case at a time, replicable)
  const [parallelSlots, setParallelSlots] = useState(1)
  const [llmOutput, setLlmOutput] = useState(null)
  const [contextError, setContextError] = useState(null)
  const [confirmRegenerateContext, setConfirmRegenerateContext] = useState(false)

  // Test list
  const [testList, setTestList] = useState([])

  // Settings
  const [similarityThreshold, setSimilarityThreshold] = useState(80)
  const [rubricMatchMode, setRubricMatchMode] = useState('exact')

  // Running / saving state
  const [isRunning, setIsRunning] = useState(false)
  const [autosaveStatus, setAutosaveStatus] = useState('idle') // idle | saving | saved | error

  const latestBlockIdRef = useRef(null)
  // Guards against the autosave effect firing when state changes are caused
  // by programmatic restoration (block select / re-run) rather than a user edit.
  const skipAutosaveRef = useRef(false)

  // The selected block, overlaid with the Analysis Builder's live data (shared
  // store) so edits made there — or here — show up everywhere instantly.
  const storeBlockData = usePromptSync(s => (selectedBlockId ? s.blocks[selectedBlockId] : null))
  const patchBlock = usePromptSync(s => s.patchBlock)
  const liveBlock = useMemo(() => {
    if (!selectedBlock) return null
    const data = storeBlockData ? { ...(selectedBlock.data || {}), ...storeBlockData } : (selectedBlock.data || {})
    return {
      ...selectedBlock,
      data,
      detection_prompt: data.detection_prompt, label_prompt: data.label_prompt,
      rubric_items: data.rubric_items, prompt: data.prompt,
      detection_threshold: data.detection_threshold, label_threshold: data.label_threshold,
    }
  }, [selectedBlock, storeBlockData])
  // Changes whenever any prompt/setting in the snapshot changes → triggers autosave of the test.
  const promptsSignature = liveBlock ? JSON.stringify(buildPromptsSnapshot(liveBlock)) : ''

  const comparisonMode = comparisonModeFor(selectedBlock)

  // Listen for alignment_complete to refresh results
  useEffect(() => {
    function onAlignmentComplete(data) {
      if (data.project_id !== projectId) return
      setIsRunning(false)
      if (data.test_id && data.status === 'complete') {
        loadTestResult(data.test_id)
        if (selectedBlockId) loadTestList(selectedBlockId)
      }
    }
    function onAlignmentStarted(data) {
      if (data.project_id !== projectId) return
      setIsRunning(true)
      if (onShowConsole) onShowConsole()
    }

    socket.on('alignment_complete', onAlignmentComplete)
    socket.on('alignment_started', onAlignmentStarted)
    return () => {
      socket.off('alignment_complete', onAlignmentComplete)
      socket.off('alignment_started', onAlignmentStarted)
    }
  }, [projectId, selectedBlockId])

  // Refresh the selected block's data from the server whenever this tab
  // becomes active, so prompt edits saved from the Analysis Builder (which
  // write straight to flow.json) show up here without needing a remount.
  useEffect(() => {
    if (isActive && selectedBlockId) {
      refreshSelectedBlockFromServer(selectedBlockId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  // Debounced autosave: persist human labels / expected output / live prompt
  // edits ~1.5s after the last change, so typing is never lost even without
  // an explicit click.
  useEffect(() => {
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false
      return
    }
    if (!currentTestId) return

    setAutosaveStatus('saving')
    const timer = setTimeout(async () => {
      try {
        await persistTest()
        setAutosaveStatus('saved')
      } catch (err) {
        console.error('Autosave failed:', err)
        setAutosaveStatus('error')
      }
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humanLabels, promptsSignature, humanExpected, humanRationale])

  async function refreshSelectedBlockFromServer(blockId) {
    try {
      const res = await getAlignmentBlocks(projectId)
      const fresh = Array.isArray(res.data) ? res.data.find(b => b.block_id === blockId) : null
      if (fresh && latestBlockIdRef.current === blockId) {
        setSelectedBlock(fresh)
      }
    } catch (err) {
      console.error('Failed to refresh block from server:', err)
    }
  }

  function resetWorkingState() {
    setSampleUnits([])
    setThemeReferenceList([])
    setCurrentTestId(null)
    setActiveTestData(null)
    setHumanLabels({})
    setContextText('')
    setHumanExpected('')
    setHumanRationale('')
    setLlmOutput(null)
    setContextError(null)
    setSampleSizeWarning(null)
  }

  async function handleBlockSelect(block) {
    const blockId = block?.block_id || null
    latestBlockIdRef.current = blockId

    skipAutosaveRef.current = true
    setSelectedBlock(block)
    setSelectedBlockId(blockId)
    resetWorkingState()

    if (!blockId) {
      setTestList([])
      return
    }

    loadTestList(blockId)

    // Restore whatever is in progress for this block instead of a blank slate:
    // the current draft if there is one, otherwise the most recent completed
    // test (with its results), so returning users can review or optimize it.
    setRestoringDraft(true)
    try {
      const res = await getCurrentDraftTest(projectId, blockId)
      if (latestBlockIdRef.current !== blockId) return // user switched blocks mid-flight
      let test = res.data && !res.data.error ? res.data : null
      if (!test) {
        const list = (await getAlignmentTests(projectId, blockId)).data || []
        const latest = list.find(t => t.status === 'complete')
        if (latest) test = (await getAlignmentTest(projectId, latest.test_id)).data
        if (latestBlockIdRef.current !== blockId) return
      }
      if (test && !test.error) {
        skipAutosaveRef.current = true
        setCurrentTestId(test.test_id || null)
        if (test.status === 'complete' && test.metrics) setActiveTestData(test)
        if (test.comparison_mode === 'single_output') {
          setContextText(test.context_text || '')
          setHumanExpected(test.human_expected || '')
          setHumanRationale(test.human_expected_rationale || '')
          setLlmOutput(test.llm_output || null)
        } else if (test.comparison_mode === 'per_unit_theme_match') {
          setSampleUnits(test.sample_units || [])
          setThemeReferenceList(test.theme_reference_list || [])
          setHumanLabels(test.human_labels || {})
          setSampleSizeWarning(shortfallWarning(test))
        } else {
          setSampleUnits(test.sample_units || [])
          setHumanLabels(test.human_labels || {})
          setSampleSizeWarning(shortfallWarning(test))
        }
      }
    } catch (err) {
      console.error('Failed to restore the current test:', err)
    } finally {
      if (latestBlockIdRef.current === blockId) setRestoringDraft(false)
    }
  }

  async function loadTestList(blockId) {
    try {
      const res = await getAlignmentTests(projectId, blockId)
      setTestList(res.data)
    } catch { /* ignore */ }
  }

  async function loadTestResult(testId) {
    try {
      const res = await getAlignmentTest(projectId, testId)
      setActiveTestData(res.data)
      setCurrentTestId(testId)
      if (res.data.llm_output != null) setLlmOutput(res.data.llm_output)
    } catch (err) {
      console.error('Failed to load test result:', err)
    }
  }

  function handleSampleGenerated(data) {
    skipAutosaveRef.current = true
    setSampleUnits(data.sample_units || [])
    setHumanLabels({})
    setActiveTestData(null)
    setCurrentTestId(data.test_id || null)
    setSampleSizeWarning(shortfallWarning(data))
    if (selectedBlockId) loadTestList(selectedBlockId)
  }

  function handleThemeSampleGenerated(data) {
    skipAutosaveRef.current = true
    setSampleSizeWarning(shortfallWarning(data))
    setSampleUnits(data.sample_units || [])
    setThemeReferenceList(data.theme_reference_list || [])
    setHumanLabels({})
    setActiveTestData(null)
    setCurrentTestId(data.test_id || null)
    if (selectedBlockId) loadTestList(selectedBlockId)
  }

  async function loadSingleOutputContext(confirmIfExisting) {
    if (confirmIfExisting && (contextText || humanExpected)) {
      setConfirmRegenerateContext(true)
      return
    }
    setContextError(null)
    try {
      const res = await generateSingleOutputTest(projectId, selectedBlockId)
      if (res.data.error) {
        setContextError(res.data.error)
        return
      }
      skipAutosaveRef.current = true
      setContextText(res.data.context_text || '')
      setHumanExpected('')
      setHumanRationale('')
      setLlmOutput(null)
      setActiveTestData(null)
      setCurrentTestId(res.data.test_id || null)
      if (selectedBlockId) loadTestList(selectedBlockId)
    } catch (err) {
      setContextError(err.response?.data?.error || 'Failed to load context')
    }
  }

  function handleHumanExpectedChange(value) {
    setHumanExpected(value)
  }

  function buildTestPayload() {
    const base = {
      test_id: currentTestId || undefined,
      block_id: selectedBlockId,
      block_type: liveBlock?.block_type,
      block_label: liveBlock?.label,
      parallel_slots: parallelSlots,
    }

    if (comparisonMode === 'single_output') {
      return {
        ...base,
        comparison_mode: 'single_output',
        context_text: contextText,
        human_expected: humanExpected,
        human_expected_rationale: humanRationale,
        prompts_snapshot: liveBlock ? buildPromptsSnapshot(liveBlock) : null,
      }
    }

    if (comparisonMode === 'per_unit_theme_match') {
      return {
        ...base,
        comparison_mode: 'per_unit_theme_match',
        prompts_snapshot: liveBlock ? buildPromptsSnapshot(liveBlock) : null,
        theme_reference_list: themeReferenceList,
        sample_size: sampleUnits.length,
        sample_unit_ids: sampleUnits.map(u => u.unit_id),
        sample_units: sampleUnits,
        human_labels: humanLabels,
      }
    }

    const blockData = liveBlock?.data || liveBlock || {}
    return {
      ...base,
      sample_size: sampleUnits.length,
      similarity_threshold: similarityThreshold,
      rubric_match_mode: rubricMatchMode,
      source_config: {
        source_type: blockData.source_type || 'all',
        source_doc_index: blockData.source_doc_index || null,
        source_doc_label: null,
        source_folder_name: blockData.source_folder_name || null,
        unit_type: blockData.unit_type || 'sentence',
      },
      prompts_snapshot: liveBlock ? buildPromptsSnapshot(liveBlock) : null,
      sample_unit_ids: sampleUnits.map(u => u.unit_id),
      sample_units: sampleUnits,
      human_labels: humanLabels,
    }
  }

  async function persistTest() {
    const res = await saveAlignmentTest(projectId, buildTestPayload())
    setCurrentTestId(res.data.test_id)
    setActiveTestData(res.data)
    return res.data
  }

  async function handleSaveTest() {
    if (!liveBlock) return
    setAutosaveStatus('saving')
    try {
      await persistTest()
      setAutosaveStatus('saved')
      loadTestList(selectedBlockId)
    } catch (err) {
      console.error('Failed to save test:', err)
      setAutosaveStatus('error')
    }
  }

  async function handleRunComparison() {
    // Always persist first to ensure the latest labels + on-screen prompts are used.
    try {
      // Make sure block settings (Builder's flow.json) and prompt templates are on
      // disk — the runner reads templates and non-snapshotted block settings from there.
      const sync = usePromptSync.getState()
      await sync.flushFlow()
      await sync.flushOverrides()
      const saved = await persistTest()
      const testId = saved.test_id
      setIsRunning(true)
      await runAlignmentComparison(projectId, testId)
    } catch (err) {
      console.error('Failed to start comparison:', err)
      setIsRunning(false)
    }
  }

  async function handleTestSelect(testId) {
    await loadTestResult(testId)
  }

  function handleTestDeleted(testId) {
    setTestList(prev => prev.filter(t => t.test_id !== testId))
    if (currentTestId === testId) {
      setCurrentTestId(null)
      setActiveTestData(null)
    }
  }

  async function handleRerun(testId) {
    // Load an old test's sample + labels and make it the current working
    // draft again (same test_id), so per-row saves and autosave continue
    // updating it rather than fragmenting into yet another new file.
    try {
      const res = await getAlignmentTest(projectId, testId)
      const oldTest = res.data
      skipAutosaveRef.current = true
      setCurrentTestId(oldTest.test_id)
      setActiveTestData(null)
      if (oldTest.comparison_mode === 'single_output') {
        setContextText(oldTest.context_text || '')
        setHumanExpected(oldTest.human_expected || '')
        setHumanRationale(oldTest.human_expected_rationale || '')
        setLlmOutput(oldTest.llm_output || null)
      } else if (oldTest.comparison_mode === 'per_unit_theme_match') {
        setSampleUnits(oldTest.sample_units || [])
        setThemeReferenceList(oldTest.theme_reference_list || [])
        setHumanLabels(oldTest.human_labels || {})
        setSampleSizeWarning(shortfallWarning(oldTest))
      } else {
        setSampleUnits(oldTest.sample_units || [])
        setHumanLabels(oldTest.human_labels || {})
        setSampleSizeWarning(shortfallWarning(oldTest))
      }
      await saveAlignmentTest(projectId, { test_id: oldTest.test_id, block_id: selectedBlockId, status: 'draft' })
      loadTestList(selectedBlockId)
    } catch (err) {
      console.error('Failed to load test for re-run:', err)
    }
  }

  // Snapshot of the block's live prompts/settings (from the shared store, so
  // it always matches what the Analysis Builder shows right now).
  function buildPromptsSnapshot(block) {
    const data = block.data || block
    switch (block.block_type) {
      case 'sourceAnalysis':
        return {
          detection_prompt: data.detection_prompt ?? '',
          label_prompt: data.label_prompt ?? '',
          detection_threshold: data.detection_threshold || 70.0,
          label_threshold: data.label_threshold || 70.0,
          rubric_items: null,
        }
      case 'rubricAnalysis':
        return {
          detection_prompt: null,
          label_prompt: null,
          detection_threshold: null,
          label_threshold: data.label_threshold || 70.0,
          rubric_items: data.rubric_items ?? [],
        }
      case 'customPrompt':
        return { prompt: data.prompt ?? '' }
      case 'categoryBuild':
        return { max_categories: data.max_categories ?? 6 }
      case 'themeIdent':
        return { theme_threshold: data.theme_threshold ?? 80 }
      default:
        return null
    }
  }

  const hasWorkInProgress = comparisonMode === 'single_output'
    ? Boolean(contextText)
    : sampleUnits.length > 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h2 className="text-gray-900 text-xl font-semibold">Alignment Testing</h2>

      {confirmRegenerateContext && (
        <ConfirmDialog
          title="Reload Comparison Context?"
          message="This will discard your current expected-output text and reload the input context fresh. This cannot be undone. Continue?"
          onConfirm={() => { setConfirmRegenerateContext(false); loadSingleOutputContext(false) }}
          onCancel={() => setConfirmRegenerateContext(false)}
        />
      )}

      {/* Step 1: Block Selection */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-gray-900 font-medium mb-3">1. Select Block</h3>
        <BlockSelector
          projectId={projectId}
          isActive={isActive}
          selectedBlockId={selectedBlockId}
          onSelect={handleBlockSelect}
        />
      </div>

      {/* Live prompts & settings — shared with the Analysis Builder and Default Prompt Editor */}
      {liveBlock && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
          <details open>
            <summary className="cursor-pointer text-amber-900 font-medium text-sm">
              Block prompts &amp; settings
            </summary>
            <p className="text-amber-700 text-xs mt-2 mb-3">
              Live-linked to the Analysis Builder: edit here or there and both update instantly (saved automatically).
              Comparison runs always use what is shown here.
            </p>
            <BlockPromptsPanel
              block={liveBlock}
              onPatch={(patch) => patchBlock(selectedBlockId, patch)}
            />
          </details>
          <details className="mt-3">
            <summary className="cursor-pointer text-amber-900 font-medium text-sm">
              Prompt templates that wrap each case (system / unit intro / context / follow-ups)
            </summary>
            <div className="mt-3">
              <TemplatesPanel projectId={projectId} blockType={liveBlock.block_type} />
            </div>
          </details>
        </div>
      )}

      {/* Step 2: Generate Sample / Load Context */}
      {liveBlock && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-gray-900 font-medium mb-3">
            2. {comparisonMode === 'single_output' ? 'Load Comparison Context' : 'Generate Sample'}
          </h3>

          {(() => {
            const gran = granularityDescription(liveBlock)
            return gran ? (
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium">
                  Sentence-level within cell ({gran.column})
                </span>
                <span className="text-gray-500">split by {gran.methodText} — matches this block's "Analyze At" setting in the Analysis Builder</span>
              </div>
            ) : null
          })()}

          {liveBlock?.data?.context_mode === 'paragraph' && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium">
                {liveBlock?.data?.sentence_column ? 'Full Cell Context' : 'Full Paragraph Context'}
              </span>
              <span className="text-gray-500">
                {liveBlock?.data?.sentence_column
                  ? 'samples show the surrounding cell, not N neighboring units'
                  : 'samples show the surrounding paragraph, not N neighboring units'}
                {' '}— matches this block's "Context Mode" setting in the Analysis Builder
              </span>
            </div>
          )}

          {comparisonMode === 'per_unit' && (
            <SampleGenerator
              projectId={projectId}
              blockId={selectedBlockId}
              hasExistingSample={sampleUnits.length > 0}
              onSampleGenerated={handleSampleGenerated}
            />
          )}

          {comparisonMode === 'per_unit_theme_match' && (
            <ThemeSampleGenerator
              projectId={projectId}
              blockId={selectedBlockId}
              hasExistingSample={sampleUnits.length > 0}
              onSampleGenerated={handleThemeSampleGenerated}
            />
          )}

          {comparisonMode === 'single_output' && (
            <div>
              <button
                onClick={() => loadSingleOutputContext(true)}
                disabled={!selectedBlockId}
                className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {contextText ? 'Reload Context' : 'Load Context'}
              </button>
              {contextError && <p className="mt-2 text-red-600 text-sm">{contextError}</p>}
            </div>
          )}

          {restoringDraft && (
            <p className="text-gray-400 text-sm mt-2">Restoring your in-progress work…</p>
          )}
          {!restoringDraft && comparisonMode !== 'single_output' && sampleUnits.length > 0 && (
            <p className="text-gray-500 text-sm mt-2">
              {sampleUnits.length} units sampled — this sample stays the same until you generate a new one.
            </p>
          )}
          {!restoringDraft && sampleSizeWarning && (
            <p className="mt-2 text-amber-700 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠ {sampleSizeWarning}
            </p>
          )}
        </div>
      )}

      {/* Step 3: Human Labeling / Expected Output + Run Comparison */}
      {hasWorkInProgress && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-gray-900 font-medium">3. Label & Compare</h3>
            {comparisonMode !== 'single_output' && (
              <label className="flex items-center gap-2 text-xs text-gray-600" title="Throughput mode sends several cases to the model at once. Faster on GPU / unified-memory machines, but batched requests can change results slightly.">
                Cases in parallel
                <select value={parallelSlots} onChange={(e) => setParallelSlots(Number(e.target.value))}
                  className="px-1.5 py-0.5 border border-gray-300 rounded">
                  <option value={1}>1 (replicable)</option>
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                </select>
                {parallelSlots > 1 && <span className="text-amber-700">results may differ slightly from a one-at-a-time run</span>}
                <ParallelSlotsNote slots={parallelSlots} />
              </label>
            )}
          </div>

          {comparisonMode === 'per_unit' && (
            <HumanLabelingPanel
              key={`${selectedBlockId}-${labelsVersion}`}
              projectId={projectId}
              block={liveBlock}
              sampleUnits={sampleUnits}
              testId={currentTestId}
              humanLabels={humanLabels}
              onHumanLabelsChange={setHumanLabels}
              similarityThreshold={similarityThreshold}
              onSimilarityThresholdChange={setSimilarityThreshold}
              rubricMatchMode={rubricMatchMode}
              onRubricMatchModeChange={setRubricMatchMode}
              onSaveTest={handleSaveTest}
              onRunComparison={handleRunComparison}
              autosaveStatus={autosaveStatus}
              isRunning={isRunning}
            />
          )}

          {comparisonMode === 'per_unit_theme_match' && (
            <ThemeMatchLabelingPanel
              key={selectedBlockId}
              projectId={projectId}
              sampleUnits={sampleUnits}
              themeReferenceList={themeReferenceList}
              testId={currentTestId}
              humanLabels={humanLabels}
              onHumanLabelsChange={setHumanLabels}
              onSaveTest={handleSaveTest}
              onRunComparison={handleRunComparison}
              autosaveStatus={autosaveStatus}
              isRunning={isRunning}
            />
          )}

          {comparisonMode === 'single_output' && (
            <SingleOutputComparisonPanel
              key={selectedBlockId}
              blockType={liveBlock?.block_type}
              contextText={contextText}
              humanExpected={humanExpected}
              onHumanExpectedChange={handleHumanExpectedChange}
              humanRationale={humanRationale}
              onHumanRationaleChange={setHumanRationale}
              llmOutput={llmOutput}
              onSaveTest={handleSaveTest}
              onRunComparison={handleRunComparison}
              autosaveStatus={autosaveStatus}
              isRunning={isRunning}
            />
          )}
        </div>
      )}

      {/* Step 4: Results */}
      {activeTestData?.metrics && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <ComparisonResults
            projectId={projectId}
            testData={activeTestData}
            blockType={liveBlock?.block_type}
            testList={testList.filter(t => t.status === 'complete')}
          />
        </div>
      )}

      {/* Step 6: Automated prompt optimization (open-coding + rubric) */}
      {liveBlock && ['sourceAnalysis', 'rubricAnalysis'].includes(liveBlock.block_type) && currentTestId && sampleUnits.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-gray-900 font-medium mb-3">Optimize prompts (automated)</h3>
          <OptimizationPanel
            projectId={projectId}
            block={liveBlock}
            testId={currentTestId}
            humanLabels={humanLabels}
            onRationaleSaved={(unitId, label) => {
              if (!label) return
              setHumanLabels(prev => ({ ...prev, [unitId]: { ...(prev[unitId] || {}), ...label } }))
              setLabelsVersion(v => v + 1)
            }}
            onApplyPrompts={(prompts) => patchBlock(selectedBlockId, prompts)}
          />
        </div>
      )}

      {/* Step 5: Test History */}
      {testList.length > 0 && (
        <TestHistory
          projectId={projectId}
          blockId={selectedBlockId}
          tests={testList}
          onTestSelect={handleTestSelect}
          onTestDeleted={handleTestDeleted}
          onRerun={handleRerun}
        />
      )}
    </div>
  )
}

function ThemeSampleGenerator({ projectId, blockId, hasExistingSample, onSampleGenerated }) {
  const [sampleSize, setSampleSize] = useState(20)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function doGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await generateThemeSample(projectId, blockId, sampleSize)
      if (res.data.error) {
        setError(res.data.error)
      } else {
        onSampleGenerated(res.data)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate sample')
    } finally {
      setGenerating(false)
    }
  }

  function handleClick() {
    if (hasExistingSample) {
      setConfirmOpen(true)
    } else {
      doGenerate()
    }
  }

  return (
    <div>
      {confirmOpen && (
        <ConfirmDialog
          title="Generate New Sample?"
          message="This will discard the current sample and any human labels entered for it. This cannot be undone. Continue?"
          onConfirm={() => { setConfirmOpen(false); doGenerate() }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
      <div className="flex gap-3 items-end">
        <label className="block">
          <span className="text-gray-600 text-xs font-medium">Sample Size</span>
          <input
            type="number"
            min="1"
            max="200"
            value={sampleSize}
            onChange={(e) => setSampleSize(parseInt(e.target.value) || 20)}
            className="block mt-1 w-24 px-2 py-1.5 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
          />
        </label>
        <button
          onClick={handleClick}
          disabled={generating || !blockId}
          className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {generating ? 'Generating...' : hasExistingSample ? 'Generate New Sample' : 'Generate Sample'}
        </button>
      </div>
      {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
    </div>
  )
}
