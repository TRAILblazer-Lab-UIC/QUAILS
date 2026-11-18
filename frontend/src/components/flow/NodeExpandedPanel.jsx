import { useState, useEffect, useRef } from 'react'
import { listDocuments, listFolders, getParsedDoc, getDocumentColumns, getBlockFiles, getBlockState, clearBlockState, resumeAnalysis, openPath, getFlow, ensureColumnReparsed, generateReport, listReports } from '../../api'
import HelpLabel from '../common/HelpLabel'
import DelimiterListInput from '../common/DelimiterListInput'
import { findUpstreamAnalysisBlock, findAllUpstreamAnalysisBlocks } from './FlowEditor'
import { useFlowOrder } from './FlowOrderContext'
import socket from '../../socket'
import { usePromptSync } from '../../store/promptSync'

const ANALYSIS_NODE_TYPES = new Set(['sourceAnalysis', 'rubricAnalysis', 'themeIdent', 'categoryBuild', 'customPrompt'])

const BLOCK_TYPE_META = {
  projectSpec:    { label: 'Project Spec',                   badge: 'bg-blue-100 text-blue-800 border-blue-300' },
  sourceAnalysis: { label: 'Open-Coding Analysis',            badge: 'bg-violet-100 text-violet-800 border-violet-300' },
  rubricAnalysis: { label: 'Rubric-Based Analysis',           badge: 'bg-sky-100 text-sky-800 border-sky-300' },
  themeIdent:     { label: 'Theme Identification',           badge: 'bg-orange-100 text-orange-800 border-orange-300' },
  categoryBuild:  { label: 'Category Builder',               badge: 'bg-lime-100 text-lime-800 border-lime-300' },
  customPrompt:   { label: 'Custom Prompt',                  badge: 'bg-teal-100 text-teal-800 border-teal-300' },
  humanReview:    { label: 'Human Review',                   badge: 'bg-rose-100 text-rose-800 border-rose-300' },
  outputsReport:  { label: 'Outputs & Report',               badge: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
}

function getExpectedOutputFiles(blockId, blockType, outputFormat, blockData) {
  switch (blockType) {
    case 'sourceAnalysis':
      return [`${blockId}_labels.csv`, `${blockId}_false.csv`]
    case 'rubricAnalysis':
      return [`${blockId}_labels.csv`]
    case 'themeIdent':
      return [`${blockId}_themes.csv`, `revised${blockId}labels.csv`]
    case 'categoryBuild':
      return [`categoryReport.md`]
    case 'customPrompt':
      return [`${blockId}_output.${outputFormat === 'text' ? 'txt' : 'md'}`]
    default:
      return []
  }
}

function getPrimaryInputFile(upstreamId, upstreamType, outputFormat) {
  switch (upstreamType) {
    case 'sourceAnalysis':
      return `${upstreamId}_labels.csv`
    case 'themeIdent':
      return `${upstreamId}_themes.csv`
    case 'categoryBuild':
      return `categoryReport.md`
    case 'customPrompt':
      return `${upstreamId}_output.${outputFormat === 'text' ? 'txt' : 'md'}`
    default:
      return null
  }
}

function getFileDescription(filename, blockType) {
  if (filename.endsWith('_labels.csv') && blockType === 'sourceAnalysis')
    return 'Labelled text units that passed detection. Columns: line_number, unit_id, label, reasoning, label_confidence, detection_confidence.'
  if (filename.endsWith('_false.csv') && blockType === 'sourceAnalysis')
    return 'Text units that failed detection — assessed as not relevant to the analysis question. Columns: id, unit_id, false_confidence.'
  if (filename.endsWith('_labels.csv') && blockType === 'rubricAnalysis')
    return 'Every text unit scored against each rubric item. Columns: line_number, unit_id, then rubric_N_score, rubric_N_confidence, rubric_N_justification repeated for each rubric item.'
  if (filename.endsWith('_themes.csv'))
    return 'Identified themes extracted from the labels CSV. Columns: theme_id, label, description, supporting quotes.'
  if (filename.includes('labels.csv') && blockType === 'themeIdent')
    return 'The original labels CSV updated with a theme assignment column added for each unit.'
  if (filename === 'categoryReport.md')
    return 'A structured markdown report grouping themes into categories with summaries and representative quotes.'
  if (filename.endsWith('_output.md') || filename.endsWith('_output.txt'))
    return 'Free-form LLM output from the custom prompt — one response per document in the corpus.'
  return null
}

function FileInfoTooltip({ description }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, above: true })

  function handleEnter() {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const tipW = 256
    const above = rect.top - 90 >= 0
    let left = rect.left + rect.width / 2 - tipW / 2
    if (left < 8) left = 8
    else if (left + tipW > window.innerWidth - 8) left = window.innerWidth - 8 - tipW
    setPos({ top: above ? rect.top - 4 : rect.bottom + 4, left, above })
    setVisible(true)
  }

  return (
    <span
      className="shrink-0 cursor-help inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-600 hover:bg-blue-200 transition-colors text-[10px] font-bold leading-none"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setVisible(false)}
    >
      <span ref={ref}>i</span>
      {visible && (
        <span
          className="fixed w-64 px-2 py-1.5 text-xs text-slate-100 bg-gray-900 border border-gray-600 rounded shadow-lg z-[100] whitespace-normal leading-snug pointer-events-none"
          style={{
            left: `${pos.left}px`,
            ...(pos.above
              ? { bottom: `${window.innerHeight - pos.top}px` }
              : { top: `${pos.top}px` }),
          }}
        >
          {description}
        </span>
      )}
    </span>
  )
}

function ExpandableFileName({ filename, relPath, blockType }) {
  const [expanded, setExpanded] = useState(false)
  const description = getFileDescription(filename, blockType)

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-xs font-mono text-gray-800 truncate">{filename}</span>
        <button
          onClick={() => setExpanded(v => !v)}
          className="shrink-0 inline-flex items-center justify-center w-5 h-4 rounded bg-amber-100 text-amber-600 hover:bg-amber-200 transition-colors text-[10px] font-bold leading-none"
          title="Show full name"
        >
          ···
        </button>
        {description && <FileInfoTooltip description={description} />}
      </div>
      {expanded && (
        <div className="mt-1 px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs font-mono text-gray-700 break-all">
          {filename}
          {relPath && <div className="text-gray-400 mt-0.5">{relPath}</div>}
        </div>
      )}
      {!expanded && relPath && (
        <span className="text-xs text-gray-400 truncate block">{relPath}</span>
      )}
    </div>
  )
}

// Old saved blocks may carry a single sentence_split_delimiter string
// instead of the sentence_split_delimiters array — normalize on read.
function blockDelimiters(data) {
  if (data.sentence_split_delimiters) return data.sentence_split_delimiters
  return data.sentence_split_delimiter ? [data.sentence_split_delimiter] : []
}

function ColumnGranularityControl({ nodeId, projectId, data, handleChange, setData, onUpdate }) {
  // Sentence-level splitting always applies to whichever single column is
  // checked in "Select a Specific Column" above — no separate column picker
  // here, and no independent way for it to drift from that checked column.
  const selectedColumns = data.selected_columns || []
  const targetColumn = selectedColumns.length === 1 ? selectedColumns[0] : null
  const isSentenceLevel = !!targetColumn && data.sentence_column === targetColumn
  const method = data.sentence_split_method || 'sentence'
  const delimiters = blockDelimiters(data)
  const [parseStatus, setParseStatus] = useState('idle') // idle | pending | saving | saved | error

  useEffect(() => {
    if (!data.sentence_column) return
    if (targetColumn && data.sentence_column !== targetColumn) {
      handleChange('sentence_column', targetColumn)
    } else if (!targetColumn) {
      handleChange('sentence_column', undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetColumn])

  // Proactively persist the reparse a moment after a valid sentence-splitting
  // config settles, so it's immediately visible in the Document Viewer instead
  // of waiting for an analysis/alignment run to trigger it.
  const delimitersKey = JSON.stringify(delimiters)
  useEffect(() => {
    if (!isSentenceLevel || !targetColumn || !projectId) {
      setParseStatus('idle')
      return
    }
    const needsDelimiters = method === 'delimiter' || method === 'both'
    if (needsDelimiters && delimiters.length === 0) {
      setParseStatus('idle')
      return
    }

    setParseStatus('pending')
    const timer = setTimeout(async () => {
      setParseStatus('saving')
      try {
        const res = await ensureColumnReparsed(projectId, {
          sourceType: data.source_type,
          sourceDocIndex: data.source_doc_index,
          sourceFolderName: data.source_folder_name,
          columnName: targetColumn,
          method,
          delimiters,
        })
        setParseStatus(res.data?.error ? 'error' : 'saved')
      } catch (err) {
        console.error('Failed to persist column reparse:', err)
        setParseStatus('error')
      }
    }, 1200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSentenceLevel, targetColumn, method, delimitersKey, data.source_type, data.source_doc_index, data.source_folder_name, projectId])

  return (
    <div className="mt-3 border-t border-gray-200 pt-2">
      <HelpLabel
        label="Analyze At"
        help="By default the checked column is treated as one whole-cell value. Optionally split its cells into sentence-level sub-units instead — each sentence becomes its own analysis unit, while any other selected columns stay attached as whole-cell context. Only available when exactly one column is checked above. Splitting is saved automatically a moment after you configure it, so it's immediately visible in the Document Viewer (no need to run analysis first)."
      />
      {!targetColumn ? (
        <p className="mt-1 text-xs text-gray-400">Check exactly one column above to enable sentence-level splitting within its cells.</p>
      ) : (
        <div className="mt-1 space-y-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`granularity_${nodeId}`}
              checked={!isSentenceLevel}
              onChange={() => handleChange('sentence_column', undefined)}
            />
            <span className="text-xs text-gray-700">Whole cell</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`granularity_${nodeId}`}
                checked={isSentenceLevel}
                onChange={() => handleChange('sentence_column', targetColumn)}
              />
              <span className="text-xs text-gray-700">Parse inside the cell at the sentence level ({targetColumn})</span>
            </label>
            <HelpLabel
              label=""
              help="Use this when a single cell contains multiple units that should be analyzed separately, not all together as one unit. QUAILS can split a cell's contents by natural sentence boundaries (periods), by a custom delimiter you choose (like a semicolon), or by both sentence boundaries and delimiters at the same time."
            />
          </div>
          {isSentenceLevel && (
            <div className="pl-6 space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={`split_method_${nodeId}`}
                  checked={method === 'sentence'}
                  onChange={() => handleChange('sentence_split_method', 'sentence')}
                />
                <span className="text-xs text-gray-700">Sentence boundaries</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={`split_method_${nodeId}`}
                  checked={method === 'delimiter'}
                  onChange={() => handleChange('sentence_split_method', 'delimiter')}
                />
                <span className="text-xs text-gray-700">Custom delimiter</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={`split_method_${nodeId}`}
                  checked={method === 'both'}
                  onChange={() => handleChange('sentence_split_method', 'both')}
                />
                <span className="text-xs text-gray-700">Both sentence boundaries and delimiters</span>
              </label>
              {(method === 'delimiter' || method === 'both') && (
                <DelimiterListInput
                  delimiters={delimiters}
                  onChange={(next) => {
                    const updated = { ...data, sentence_split_delimiters: next, sentence_split_delimiter: undefined }
                    setData(updated)
                    onUpdate(updated)
                  }}
                />
              )}
              <p className="text-[11px] mt-1">
                {parseStatus === 'pending' && <span className="text-gray-400">Will split shortly…</span>}
                {parseStatus === 'saving' && <span className="text-gray-400">Splitting column…</span>}
                {parseStatus === 'saved' && <span className="text-emerald-600">✓ Split &amp; saved — visible in Document Viewer</span>}
                {parseStatus === 'error' && <span className="text-red-600">Failed to split column — try again, or use Document Viewer's Re-parse Column</span>}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Shared by sourceAnalysis and rubricAnalysis (same reason ColumnGranularityControl
// is shared above — avoids duplicating this logic across both block-type sections).
function ContextWindowControl({ nodeId, data, handleChange }) {
  // Unit of Analysis defaults a missing value to 'sentence' for display
  // (checked={(data.unit_type || 'sentence') === opt.value}) — match that
  // same fallback here so this control doesn't disagree with what the Unit
  // of Analysis radios are actually showing as selected.
  const isDocSentenceUnit = (data.unit_type || 'sentence') === 'sentence'
  // Spreadsheet blocks force unit_type to 'line' even when a column is
  // parsed at the sentence/delimiter level via ColumnGranularityControl —
  // that per-cell splitting (data.sentence_column) is a second, independent
  // notion of "sentence-level" that the plain unit_type check above misses.
  const isCellSentenceMode = !!data.sentence_column
  const isSentenceUnit = isDocSentenceUnit || isCellSentenceMode
  const isParagraphMode = isSentenceUnit && data.context_mode === 'paragraph'
  const paragraphLabel = isCellSentenceMode ? 'Full Cell' : 'Full Paragraph'
  const paragraphHelp = isCellSentenceMode
    ? 'Passes the entire cell this unit was split from as context, split into the part before it and the part after it — instead of a fixed number of neighboring units. Only available when parsing inside the cell at the sentence level.'
    : 'Passes the entire paragraph this sentence belongs to as context, split into the part before it and the part after it — instead of a fixed number of neighboring units. Only available when analyzing at the sentence level.'

  // If Unit of Analysis moves away from Sentence (and the block isn't in
  // cell-sentence mode either) while paragraph mode was active, the option
  // is no longer shown — fall back to the numeric mode so a stale selection
  // never silently reactivates if the user switches back.
  useEffect(() => {
    if (!isSentenceUnit && data.context_mode === 'paragraph') {
      handleChange('context_mode', 'units')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSentenceUnit])

  return (
    <div className="block">
      {isSentenceUnit && (
        <div className="mb-2 space-y-1">
          <HelpLabel label="Context Mode" help="Choose how surrounding text is passed to the LLM alongside each sentence being analyzed." />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`context_mode_${nodeId}`}
              checked={!isParagraphMode}
              onChange={() => handleChange('context_mode', 'units')}
            />
            <span className="text-xs text-gray-700">N units before/after</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`context_mode_${nodeId}`}
                checked={isParagraphMode}
                onChange={() => handleChange('context_mode', 'paragraph')}
              />
              <span className="text-xs text-gray-700">{paragraphLabel}</span>
            </label>
            <HelpLabel label="" help={paragraphHelp} />
          </div>
        </div>
      )}
      {!isParagraphMode && (
        <>
          <HelpLabel
            label="Context Window"
            help="Number of surrounding units included as context when the LLM analyses each unit. 1 = one unit before and one after; 0 = analyse each unit in complete isolation with no surrounding context. Leave blank to inherit the project-level default. For spreadsheet rows, 0 is strongly recommended — adjacent rows are usually independent records and including them as context confuses the model."
          />
          <input
            type="number"
            min="0"
            max="10"
            value={data.context_window ?? ''}
            onChange={(e) => {
              const val = e.target.value
              handleChange('context_window', val === '' ? null : parseInt(val, 10))
            }}
            placeholder="Project default"
            className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
          />
        </>
      )}
    </div>
  )
}

export default function NodeExpandedPanel({ node, nodes, edges, projectId, onUpdate, onDelete, onClose, onRunBlock, onResumeBlock, onOpenInData, reviewStatus = {}, onApproveReview, onRevokeReview, pipelineState, isRunning }) {
  const [reviewNote, setReviewNote] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [reports, setReports] = useState([])
  const [reportBusy, setReportBusy] = useState(false)
  const [reportError, setReportError] = useState('')

  useEffect(() => {
    setReviewNote(reviewStatus[node.id]?.note || '')
    setReviewError('')
    if (node.type === 'outputsReport' && projectId) {
      listReports(projectId).then(res => setReports(res.data || [])).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.type, projectId, pipelineState?.state])

  async function handleApprove(continueRun) {
    setReviewBusy(true)
    setReviewError('')
    try {
      await onApproveReview(node.id, reviewNote, { continueRun })
    } catch (err) {
      setReviewError(err.response?.data?.error || 'Could not record the approval.')
    } finally {
      setReviewBusy(false)
    }
  }

  async function handleGenerateReport() {
    setReportBusy(true)
    setReportError('')
    try {
      await generateReport(projectId)
      const res = await listReports(projectId)
      setReports(res.data || [])
    } catch (err) {
      setReportError(err.response?.data?.error || 'Could not generate the report.')
    } finally {
      setReportBusy(false)
    }
  }

  // ---- Review checkpoint approval ----
  function renderReviewApproval() {
    const rs = reviewStatus[node.id] || { status: 'waiting' }
    const pausedHere = pipelineState?.state === 'paused' && pipelineState?.review_id === node.id
    const labels = {
      waiting: 'Waiting for the block before this checkpoint to finish.',
      pending: 'The block has finished. Review its results, then approve.',
      approved: `Approved${rs.approved_at ? ' ' + new Date(rs.approved_at).toLocaleString() : ''}.`,
      outdated: 'The block was re-run after the last approval. Review the new results and approve again.',
    }
    return (
      <div className={`rounded p-3 space-y-2 border ${pausedHere ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'}`}>
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Checkpoint approval</p>
        {pausedHere && <p className="text-xs text-amber-800 font-medium">The pipeline is paused here.</p>}
        <p className={`text-xs ${rs.status === 'approved' ? 'text-emerald-700' : rs.status === 'outdated' ? 'text-red-600' : 'text-gray-600'}`}>{labels[rs.status] || labels.waiting}</p>
        {(rs.status === 'pending' || rs.status === 'outdated') && (
          <>
            <label className="block">
              <span className="text-xs text-gray-500">Review note (saved in the audit trail)</span>
              <textarea
                value={reviewNote}
                onChange={e => setReviewNote(e.target.value)}
                rows={2}
                placeholder="What you checked, and any concerns"
                className="w-full mt-1 px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <div className="flex gap-2">
              <button
                disabled={reviewBusy || isRunning}
                onClick={() => handleApprove(true)}
                className="flex-1 px-2 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
              >
                Approve and continue
              </button>
              <button
                disabled={reviewBusy || isRunning}
                onClick={() => handleApprove(false)}
                className="px-2 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Approve only
              </button>
            </div>
          </>
        )}
        {rs.status === 'approved' && (
          <>
            {rs.note && <p className="text-xs text-gray-500">Note: {rs.note}</p>}
            <button
              disabled={isRunning}
              onClick={() => onRevokeReview(node.id)}
              className="text-xs text-gray-500 underline hover:text-gray-700 disabled:opacity-50"
            >
              Withdraw approval
            </button>
          </>
        )}
        {reviewError && <p className="text-xs text-red-600">{reviewError}</p>}
      </div>
    )
  }

  // ---- Outputs & Report panel ----
  function renderReportSection() {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-2">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Final report</p>
        <p className="text-xs text-gray-500">A full pipeline run writes the final report when every block has finished. You can also write one now from the current results.</p>
        <button
          disabled={reportBusy || isRunning}
          onClick={handleGenerateReport}
          className="w-full px-2 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
        >
          {reportBusy ? 'Writing report…' : 'Generate report now'}
        </button>
        {reportError && <p className="text-xs text-red-600">{reportError}</p>}
        {reports.length > 0 ? (
          <ul className="space-y-1">
            {reports.map(f => (
              <li key={f} className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-gray-700 truncate">{f}</span>
                <button onClick={() => handleOpenPath(`reports/${f}`)} className="shrink-0 text-xs text-indigo-600 hover:text-indigo-800">📂 Explorer</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-400 italic">No reports yet.</p>
        )}
      </div>
    )
  }

  const sequenceOrder = useFlowOrder()
  const [data, setData] = useState({ ...node.data })
  const [docList, setDocList] = useState([])
  const [folderList, setFolderList] = useState([])
  const [docColumns, setDocColumns] = useState([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteRubricIndex, setDeleteRubricIndex] = useState(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [inputFileStatus, setInputFileStatus] = useState(null)
  const [outputFileStatus, setOutputFileStatus] = useState(null)
  const [hrUpstreamFileStatus, setHrUpstreamFileStatus] = useState(null)
  const [upstreamFileStatuses, setUpstreamFileStatuses] = useState({})
  const [blockRunState, setBlockRunState] = useState(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [isLaunching, setIsLaunching] = useState(false)
  const [launchError, setLaunchError] = useState(null)
  const [panelWidth, setPanelWidth] = useState(320)
  const activeNodeIdRef = useRef(node.id)

  // Edits made to this block from the Alignment tab arrive via the shared
  // store; fold just those keys into this panel's local copy so the next
  // edit here doesn't write stale values back over them.
  const blockPatch = usePromptSync(s => s.blockPatch)
  useEffect(() => {
    if (blockPatch.rev && blockPatch.blockId === node.id && blockPatch.patch) {
      setData(prev => ({ ...prev, ...blockPatch.patch }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockPatch.rev])

  useEffect(() => {
    activeNodeIdRef.current = node.id
    setData({ ...node.data })
    setInputFileStatus(null)
    setOutputFileStatus(null)
    setHrUpstreamFileStatus(null)
    setBlockRunState(null)
    setConfirmRestart(false)
    setIsLaunching(false)
    setLaunchError(null)

    // FlowEditor loads flow.json once at mount and stays mounted for the whole
    // session, so its in-memory copy of this node can go stale relative to
    // direct-to-disk writes made elsewhere (e.g. the Alignment tab's "Save
    // Prompts" button). Re-fetch this node's data fresh whenever its settings
    // panel opens and use it as this panel's local baseline — but only
    // update local `data`, not `onUpdate`/FlowEditor's canonical node yet.
    // Calling onUpdate here would push a possibly-stale disk snapshot back
    // into FlowEditor's state immediately, clobbering any edit the user
    // already made to this same block that hasn't reached disk yet (e.g. via
    // the debounced flow autosave, which can lag a couple of seconds behind
    // typing). The merged baseline still flows into FlowEditor once the user
    // actually edits something, since handleChange builds off local `data`.
    const nodeId = node.id
    if (projectId) {
      getFlow(projectId)
        .then(res => {
          if (activeNodeIdRef.current !== nodeId) return // user moved to a different node meanwhile
          const freshNode = (res.data?.nodes || []).find(n => n.id === nodeId)
          if (!freshNode || !freshNode.data) return
          setData({ ...node.data, ...freshNode.data })
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  useEffect(() => {
    if ((node.type === 'sourceAnalysis' || node.type === 'rubricAnalysis') && projectId) {
      Promise.all([listDocuments(projectId), listFolders(projectId)])
        .then(([docsRes, foldersRes]) => {
          setDocList(docsRes.data || [])
          setFolderList(foldersRes.data.folders || [])
        })
        .catch(() => {})
    }
  }, [node.type, projectId])

  // When single doc is selected, fetch its columns if tabular.
  // For 'all'/'folder' scope, fetch the cross-document column union instead.
  useEffect(() => {
    if (data.source_type === 'single' && data.source_doc_index != null) {
      getParsedDoc(projectId, data.source_doc_index)
        .then(res => {
          setDocColumns(res.data.columns || [])
        })
        .catch(() => setDocColumns([]))
    } else if ((data.source_type === 'all' || data.source_type === 'folder') && projectId) {
      getDocumentColumns(projectId)
        .then(res => setDocColumns(res.data.columns || []))
        .catch(() => setDocColumns([]))
    } else {
      setDocColumns([])
    }
  }, [data.source_type, data.source_doc_index, data.source_folder_name, projectId])

  // Auto-set unit_type to 'line' when a tabular doc is the selected single source.
  // Handles the case where the panel opens for a node that already has a tabular doc
  // saved in its data (docList arrives async, so we depend on it too).
  useEffect(() => {
    if (node.type !== 'sourceAnalysis' && node.type !== 'rubricAnalysis') return
    if (data.source_type !== 'single' || data.source_doc_index == null || docList.length === 0) return
    const doc = docList.find(d => d.doc_index === data.source_doc_index)
    if (!doc) return
    const isTabular = /\.(csv|xlsx|xls|numbers)$/i.test(doc.filename || '')
    if (isTabular && data.unit_type !== 'line') {
      const updated = { ...data, unit_type: 'line' }
      setData(updated)
      onUpdate(updated)
    }
  }, [data.source_doc_index, data.source_type, docList, node.type])

  // Fetch output file status for this block
  useEffect(() => {
    if (ANALYSIS_NODE_TYPES.has(node.type) && projectId) {
      getBlockFiles(projectId, node.id)
        .then(res => setOutputFileStatus(res.data))
        .catch(() => setOutputFileStatus(null))
    }
  }, [node.id, node.type, projectId])

  // Fetch block run state (save_state.json + output files) to determine which run button to show
  useEffect(() => {
    if (ANALYSIS_NODE_TYPES.has(node.type) && projectId) {
      getBlockState(projectId, node.id)
        .then(res => setBlockRunState(res.data))
        .catch(() => setBlockRunState(null))
    }
  }, [node.id, node.type, projectId])

  // Multi-upstream for themeIdent
  const upstreams = node.type === 'themeIdent' && nodes && edges
    ? findAllUpstreamAnalysisBlocks(node.id, nodes, edges)
    : []

  // Derive upstream and fetch its output file status for input display (single-input nodes only)
  const upstream = nodes && edges && ANALYSIS_NODE_TYPES.has(node.type) && node.type !== 'sourceAnalysis' && node.type !== 'rubricAnalysis' && node.type !== 'themeIdent'
    ? findUpstreamAnalysisBlock(node.id, nodes, edges)
    : null

  useEffect(() => {
    if (upstream && projectId) {
      getBlockFiles(projectId, upstream.id)
        .then(res => setInputFileStatus(res.data))
        .catch(() => setInputFileStatus(null))
    } else {
      setInputFileStatus(null)
    }
  }, [upstream?.id, projectId])

  // Fetch file statuses for all upstream blocks of themeIdent
  const upstreamIdsKey = upstreams.map(u => u.id).join(',')
  useEffect(() => {
    if (node.type === 'themeIdent' && upstreams.length > 0 && projectId) {
      Promise.all(upstreams.map(u => getBlockFiles(projectId, u.id)))
        .then(results => {
          const map = {}
          upstreams.forEach((u, i) => { map[u.id] = results[i].data })
          setUpstreamFileStatuses(map)
        })
        .catch(() => {})
    } else {
      setUpstreamFileStatuses({})
    }
  }, [upstreamIdsKey, node.type, projectId])

  // For humanReview: find the upstream analysis block via the tee edge
  const hrUpstream = node.type === 'humanReview' && nodes && edges
    ? (() => {
        const teeEdge = edges.find(e => e.type === 'tee' && e.data?.humanReviewId === node.id)
        return teeEdge ? (nodes.find(n => n.id === teeEdge.source) || null) : null
      })()
    : null

  useEffect(() => {
    if (node.type === 'humanReview' && hrUpstream && projectId) {
      getBlockFiles(projectId, hrUpstream.id)
        .then(res => setHrUpstreamFileStatus(res.data))
        .catch(() => setHrUpstreamFileStatus(null))
    } else {
      setHrUpstreamFileStatus(null)
    }
  }, [hrUpstream?.id, node.type, projectId])

  function handleChange(key, value) {
    const updated = { ...data, [key]: value }
    setData(updated)
    onUpdate(updated)
  }

  function toggleColumn(col) {
    const current = data.selected_columns || []
    const next = current.includes(col)
      ? current.filter(c => c !== col)
      : [...current, col]
    handleChange('selected_columns', next)
  }

  function clearColumnSelection() {
    handleChange('selected_columns', [])
  }

  function handleResizeMouseDown(e) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    function onMouseMove(ev) {
      // Panel is right-anchored: dragging left increases width
      const next = Math.max(280, Math.min(680, startWidth + (startX - ev.clientX)))
      setPanelWidth(next)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function updateRubricItem(index, key, value) {
    const items = [...(data.rubric_items || [])]
    items[index] = { ...items[index], [key]: value }
    handleChange('rubric_items', items)
  }

  function addRubricItem() {
    handleChange('rubric_items', [...(data.rubric_items || []), { title: '', description: '', scoring_prompt: '' }])
  }

  function removeRubricItem(index) {
    const items = [...(data.rubric_items || [])]
    items.splice(index, 1)
    handleChange('rubric_items', items)
    setDeleteRubricIndex(null)
  }

  async function handleOpenPath(relativePath) {
    try {
      await openPath(projectId, relativePath)
    } catch (err) {
      console.error('Failed to open path:', err)
    }
  }

  function refreshBlockState() {
    if (ANALYSIS_NODE_TYPES.has(node.type) && projectId) {
      getBlockState(projectId, node.id)
        .then(res => setBlockRunState(res.data))
        .catch(() => {})
    }
  }

  // Refresh run-button state when this block's analysis finishes or the whole pipeline completes.
  useEffect(() => {
    if (!ANALYSIS_NODE_TYPES.has(node.type)) return
    function onBlockComplete(data) {
      if (data.block_id === node.id) refreshBlockState()
    }
    function onAnalysisComplete() {
      refreshBlockState()
    }
    socket.on('block_complete', onBlockComplete)
    socket.on('analysis_complete', onAnalysisComplete)
    return () => {
      socket.off('block_complete', onBlockComplete)
      socket.off('analysis_complete', onAnalysisComplete)
    }
  }, [node.id, node.type, projectId])

  // Derive which run button mode to show based on save_state.json + output files
  function getRunMode() {
    if (!blockRunState) return 'start'
    const { has_save_state, is_complete, any_output_exist } = blockRunState
    if (!has_save_state && !any_output_exist) return 'start'
    if (is_complete || (!has_save_state && any_output_exist)) return 'redo'
    if (has_save_state && !is_complete) return 'resume'
    return 'start'
  }

  // ---- Human Review files section ----
  function renderHumanReviewSection() {
    if (!hrUpstream) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <p className="text-xs text-amber-700 font-medium">Not connected</p>
          <p className="text-xs text-amber-600 mt-0.5">Connect two analysis blocks to create a review checkpoint. Files from the upstream block will appear here.</p>
        </div>
      )
    }

    const expectedFiles = getExpectedOutputFiles(hrUpstream.id, hrUpstream.type, hrUpstream.data?.output_format, hrUpstream.data)

    return (
      <div className="bg-rose-50 border border-rose-200 rounded p-3 space-y-2">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Files for Human Review</p>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs text-gray-700">
            Output from <strong>{hrUpstream.data?.label || hrUpstream.id}</strong>
          </p>
          {sequenceOrder[hrUpstream.id] != null && (
            <span className="shrink-0 text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
              Step {sequenceOrder[hrUpstream.id]}
            </span>
          )}
        </div>
        <p className="text-xs font-mono text-gray-400">{hrUpstream.id}</p>
        {expectedFiles.length > 0 ? (
          <ul className="space-y-1.5">
            {expectedFiles.map(filename => {
              const relPath = `blocks/${hrUpstream.id}/${filename}`
              const fileInfo = hrUpstreamFileStatus?.files?.find(f => f.name === filename)
              const exists = fileInfo?.exists ?? false
              const isCsv = filename.endsWith('.csv')
              return (
                <li key={filename} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <ExpandableFileName filename={filename} relPath={relPath} blockType={hrUpstream.type} />
                    <div className="shrink-0 flex items-center gap-1.5">
                      {exists ? (
                        <>
                          <span className="text-green-600 text-xs font-bold">✓</span>
                          <button
                            onClick={() => handleOpenPath(relPath)}
                            className="text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                          >
                            📂 Explorer
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400 italic">not yet created</span>
                      )}
                    </div>
                  </div>
                  {isCsv && (
                    <button
                      onClick={exists ? () => onOpenInData && onOpenInData(hrUpstream.id, filename) : undefined}
                      disabled={!exists}
                      title={exists ? 'Open in Data Browser' : 'File not yet generated'}
                      className={`text-xs whitespace-nowrap ${
                        exists
                          ? 'text-violet-600 hover:text-violet-800'
                          : 'text-gray-300 cursor-not-allowed'
                      }`}
                    >
                      📊 Data Browser
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-gray-400 italic">No output files expected for this block type.</p>
        )}
        <p className="text-xs text-gray-400 break-all">
          Saved to: <span className="font-mono">projects/{projectId}/blocks/{hrUpstream.id}/</span>
        </p>
      </div>
    )
  }

  // ---- Input section for downstream blocks ----
  function renderInputSection() {
    if (node.type === 'sourceAnalysis' || node.type === 'rubricAnalysis') {
      return (
        <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-1">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Input</p>
          <p className="text-xs text-gray-400">Source units loaded from: <span className="font-mono">parsed/doc_*.json</span></p>
        </div>
      )
    }

    if (node.type === 'themeIdent') {
      if (upstreams.length === 0) {
        return (
          <div className="bg-amber-50 border border-amber-200 rounded p-3">
            <p className="text-xs text-amber-700 font-medium">Not connected</p>
            <p className="text-xs text-amber-600 mt-0.5">Connect one or more analysis blocks to feed their labels into this Theme Identification block.</p>
          </div>
        )
      }
      return (
        <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-3">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Input ({upstreams.length} source{upstreams.length > 1 ? 's' : ''})
          </p>
          {upstreams.map(u => {
            const inputFilename = `${u.id}_labels.csv`
            const inputRelPath = `blocks/${u.id}/${inputFilename}`
            const fileStatus = upstreamFileStatuses[u.id]
            const inputFile = fileStatus?.files?.find(f => f.name === inputFilename)
            const inputExists = inputFile?.exists ?? false
            return (
              <div key={u.id} className="border border-gray-200 rounded p-2 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs text-gray-700 font-semibold">{u.data?.label || u.id}</p>
                  {sequenceOrder[u.id] != null && (
                    <span className="shrink-0 text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                      Step {sequenceOrder[u.id]}
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-gray-400">{u.id}</p>
                <div className="flex items-center justify-between gap-2">
                  <ExpandableFileName filename={inputFilename} relPath={inputRelPath} blockType={u.type} />
                  <div className="shrink-0 flex items-center gap-1.5">
                    {inputExists ? (
                      <>
                        <span className="text-green-600 text-xs font-bold">✓</span>
                        <button
                          onClick={() => handleOpenPath(inputRelPath)}
                          className="text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                        >
                          📂 Explorer
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-gray-400 italic">not yet created</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={inputExists ? () => onOpenInData && onOpenInData(u.id, inputFilename) : undefined}
                  disabled={!inputExists}
                  title={inputExists ? 'Open in Data Browser' : 'File not yet generated'}
                  className={`text-xs whitespace-nowrap ${inputExists ? 'text-violet-600 hover:text-violet-800' : 'text-gray-300 cursor-not-allowed'}`}
                >
                  📊 Data Browser
                </button>
                <p className="text-xs text-gray-400 break-all">
                  Saved to: <span className="font-mono">projects/{projectId}/blocks/{u.id}/</span>
                </p>
              </div>
            )
          })}
        </div>
      )
    }

    if (!upstream) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <p className="text-xs text-amber-700 font-medium">Not connected</p>
          <p className="text-xs text-amber-600 mt-0.5">Draw an edge from an upstream block to set input.</p>
        </div>
      )
    }

    if (node.type === 'categoryBuild' && upstream.type !== 'themeIdent') {
      return (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-xs text-red-700 font-medium">Wrong input</p>
          <p className="text-xs text-red-600 mt-0.5">Category Builder needs a Theme Identification block as its input. It is connected to {upstream.data?.label || upstream.id}. Route open-coding or rubric results through Theme Identification first.</p>
        </div>
      )
    }

    const upstreamOutputFormat = upstream.data?.output_format
    const inputFilename = getPrimaryInputFile(upstream.id, upstream.type, upstreamOutputFormat)
    const inputRelPath = inputFilename ? `blocks/${upstream.id}/${inputFilename}` : null

    // Find the file status in the upstream's block-files response
    const inputFile = inputFileStatus?.files?.find(f => f.name === inputFilename)
    const inputExists = inputFile?.exists ?? false

    return (
      <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-2">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Input</p>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs text-gray-700">
            Output from <strong>{upstream.data?.label || upstream.id}</strong>
          </p>
          {sequenceOrder[upstream.id] != null && (
            <span className="shrink-0 text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
              Step {sequenceOrder[upstream.id]}
            </span>
          )}
        </div>
        <p className="text-xs font-mono text-gray-400">{upstream.id}</p>
        {inputFilename && (
          <div className="flex items-center justify-between gap-2">
            <ExpandableFileName filename={inputFilename} relPath={inputRelPath} blockType={upstream.type} />
            {inputExists ? (
              <button
                onClick={() => handleOpenPath(inputRelPath)}
                className="shrink-0 text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
              >
                📂 Open in Explorer
              </button>
            ) : (
              <span className="shrink-0 text-xs text-gray-400 italic">not yet created</span>
            )}
          </div>
        )}
      </div>
    )
  }

  // ---- Output section ----
  function renderOutputSection() {
    if (!ANALYSIS_NODE_TYPES.has(node.type)) return null

    const expectedFiles = getExpectedOutputFiles(node.id, node.type, data.output_format, data)

    return (
      <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-2">
        {blockRunState?.failed && (
          <div className="bg-red-50 border border-red-200 rounded p-2">
            <p className="text-xs text-red-700 font-semibold">Last run failed</p>
            <p className="text-xs text-red-600 mt-0.5">{blockRunState.error}</p>
          </div>
        )}
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Output files</p>
        <ul className="space-y-1.5">
          {expectedFiles.map(filename => {
            const relPath = `blocks/${node.id}/${filename}`
            const fileInfo = outputFileStatus?.files?.find(f => f.name === filename)
            const exists = fileInfo?.exists ?? false
            const isCsv = filename.endsWith('.csv')
            return (
              <li key={filename} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <ExpandableFileName filename={filename} relPath={relPath} blockType={node.type} />
                  <div className="shrink-0 flex items-center gap-1.5">
                    {exists ? (
                      <>
                        <span className="text-green-600 text-xs font-bold">✓</span>
                        <button
                          onClick={() => handleOpenPath(relPath)}
                          className="text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                        >
                          📂 Explorer
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-gray-400 italic">not yet created</span>
                    )}
                  </div>
                </div>
                {isCsv && (
                  <button
                    onClick={exists ? () => onOpenInData && onOpenInData(node.id, filename) : undefined}
                    disabled={!exists}
                    title={exists ? 'Open in Data Browser' : 'File not yet generated'}
                    className={`text-xs whitespace-nowrap ${
                      exists
                        ? 'text-violet-600 hover:text-violet-800'
                        : 'text-gray-300 cursor-not-allowed'
                    }`}
                  >
                    📊 Data Browser
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-gray-400 break-all">
          Saved to: <span className="font-mono">projects/{projectId}/blocks/{node.id}/</span>
        </p>

        {/* Smart run controls */}
        {(() => {
          const runMode = getRunMode()
          const existingFiles = (blockRunState?.output_files || []).filter(f => f.exists)

          if (confirmRestart) {
            return (
              <div className="mt-1 bg-amber-50 border border-amber-200 rounded p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-800">
                  {runMode === 'redo' ? 'Redo will delete all existing results:' : 'Start Over will discard partial progress:'}
                </p>
                {existingFiles.length > 0 && (
                  <ul className="space-y-0.5">
                    {existingFiles.map(f => (
                      <li key={f.name} className="text-xs font-mono text-amber-700">• {f.name}</li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setConfirmRestart(false)}
                    className="flex-1 px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setConfirmRestart(false)
                      await clearBlockState(projectId, node.id)
                      onRunBlock && onRunBlock(node.id)
                      setTimeout(refreshBlockState, 800)
                    }}
                    className="flex-1 px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-500"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )
          }

          if (runMode === 'resume') {
            return (
              <div className="mt-1 space-y-1.5">
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                  <span className="text-amber-600 text-sm">⏸</span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-amber-800">Interrupted</p>
                    {blockRunState?.completed_count > 0 && (
                      <p className="text-xs text-amber-600">{blockRunState.completed_count} unit{blockRunState.completed_count !== 1 ? 's' : ''} processed</p>
                    )}
                  </div>
                </div>
                <button
                  disabled={isLaunching}
                  onClick={async () => {
                    setIsLaunching(true)
                    setLaunchError(null)
                    try {
                      if (onResumeBlock) await onResumeBlock(node.id)
                      setTimeout(refreshBlockState, 800)
                    } catch (err) {
                      const msg = err.response?.data?.error || err.message || 'Failed to resume analysis'
                      setLaunchError(msg)
                    } finally {
                      setIsLaunching(false)
                    }
                  }}
                  className={`w-full px-3 py-1.5 text-xs rounded font-medium flex items-center justify-center gap-1.5 ${
                    isLaunching ? 'bg-indigo-400 text-white cursor-wait' : 'bg-indigo-600 text-white hover:bg-indigo-500'
                  }`}
                >
                  {isLaunching ? (
                    <>
                      <svg className="animate-spin h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Launching…
                    </>
                  ) : '▶ Resume'}
                </button>
                <button
                  onClick={() => setConfirmRestart(true)}
                  className="w-full px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                >
                  Start Over
                </button>
                {launchError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                    ⚠ {launchError}
                  </p>
                )}
              </div>
            )
          }

          if (runMode === 'redo') {
            return (
              <div className="mt-1 space-y-1.5">
                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5">
                  <span className="text-emerald-600 text-sm">✓</span>
                  <p className="text-xs font-semibold text-emerald-800">Analysis complete</p>
                </div>
                <button
                  onClick={() => setConfirmRestart(true)}
                  className="w-full px-3 py-1.5 text-xs text-amber-700 border border-amber-300 rounded hover:bg-amber-50"
                >
                  Redo Analysis
                </button>
              </div>
            )
          }

          // 'start' mode
          return (
            <div className="mt-1 space-y-1">
              <button
                disabled={isLaunching}
                onClick={async () => {
                  setIsLaunching(true)
                  setLaunchError(null)
                  try {
                    if (onRunBlock) await onRunBlock(node.id)
                    setTimeout(refreshBlockState, 800)
                  } catch (err) {
                    const msg = err.response?.data?.error || err.message || 'Failed to start analysis'
                    setLaunchError(msg)
                  } finally {
                    setIsLaunching(false)
                  }
                }}
                className={`w-full px-3 py-1.5 text-xs rounded flex items-center justify-center gap-1.5 ${
                  isLaunching
                    ? 'bg-indigo-50 text-indigo-400 border border-indigo-200 cursor-wait'
                    : 'text-indigo-600 border border-indigo-300 hover:bg-indigo-50'
                }`}
              >
                {isLaunching && (
                  <svg className="animate-spin h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {isLaunching ? 'Launching…' : 'Start Analysis'}
              </button>
              {launchError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                  ⚠ {launchError}
                </p>
              )}
            </div>
          )
        })()}
      </div>
    )
  }

  return (
    <div className="absolute right-4 top-20" style={{ width: panelWidth }}>
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-4 cursor-ew-resize z-[60] group"
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize panel"
      >
        {/* Full-height bar */}
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gray-400 group-hover:bg-gray-600 rounded-l-lg transition-colors duration-150" />
        {/* Centered icon badge */}
        <div className="absolute top-1/2 left-0 -translate-y-1/2 w-4 h-9 bg-gray-400 group-hover:bg-gray-600 rounded-r flex items-center justify-center shadow-md transition-colors duration-150 pointer-events-none">
          <svg width="8" height="14" viewBox="0 0 8 14" fill="none">
            <path d="M2.5 4L1 7L2.5 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5.5 4L7 7L5.5 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
    <div className="bg-white border border-gray-200 rounded-lg shadow-xl z-50 max-h-[80vh] overflow-y-auto">
      <div className="flex items-start justify-between p-4 border-b border-gray-200">
        <div className="space-y-1">
          {BLOCK_TYPE_META[node.type] && (
            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded border ${BLOCK_TYPE_META[node.type].badge}`}>
              {BLOCK_TYPE_META[node.type].label}
            </span>
          )}
          <h3 className="text-gray-900 font-semibold text-sm">Block Settings</h3>
          <p className="text-xs text-gray-500">
            Block ID: <span className="font-mono text-gray-700">{node.id}</span>
          </p>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Step:</span>
            {sequenceOrder[node.id] != null
              ? <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Step {sequenceOrder[node.id]}</span>
              : <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-500">–</span>
            }
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900 mt-0.5">&#x2715;</button>
      </div>

      <div className="p-4 space-y-4">
        <label className="block">
          <HelpLabel label="Label" help="Display name for this block in the flow editor. Does not affect analysis." />
          <input
            value={data.label || ''}
            onChange={(e) => handleChange('label', e.target.value)}
            className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
          />
        </label>

        {(node.type === 'sourceAnalysis' || node.type === 'rubricAnalysis') && (
          <label className="block">
            <HelpLabel label="Goals of Analysis" help="Describe what you want this analysis block to accomplish. What are you looking for in the data? What kinds of patterns, themes, or evidence should the AI identify? This is for your own reference and does not affect the AI's behavior — use the prompts below to instruct the AI." />
            <textarea
              value={data.analysis_goals || ''}
              onChange={(e) => handleChange('analysis_goals', e.target.value)}
              className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              rows={3}
              placeholder="What are your goals for this analysis block?"
            />
          </label>
        )}

        {/* Model Parameters — projectSpec only */}
        {node.type === 'projectSpec' && (
          <div className="mt-3 space-y-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200 pb-1">
              Model Parameters
            </div>

            {[
              {
                key: 'temperature',
                label: 'Temperature',
                step: 0.01, min: 0, max: 2, defaultVal: 0,
                help: 'Controls output randomness. 0 = fully deterministic — the model always picks the highest-probability token, producing identical results on every run. Recommended for research replication.',
              },
              {
                key: 'seed',
                label: 'Seed',
                step: 1, min: 0, max: 99999, defaultVal: 5,
                help: 'Random seed passed to the model. Combined with Temperature = 0, a fixed seed guarantees bit-identical results when the same analysis is re-run, enabling exact study replication.',
              },
              {
                key: 'top_k',
                label: 'Top-K',
                step: 1, min: 1, max: 100, defaultVal: 3,
                help: 'Limits the model to the top K most likely tokens at each step. Lower values (e.g. 3) reduce hallucination and keep outputs focused on the most probable answers. Higher values allow more variety.',
              },
              {
                key: 'top_p',
                label: 'Top-P (nucleus)',
                step: 0.01, min: 0, max: 1, defaultVal: 0.9,
                help: 'Nucleus sampling: only tokens whose cumulative probability reaches P are considered. Works alongside Top-K. Values near 1.0 allow more diversity; lower values keep the model more conservative.',
              },
              {
                key: 'repeat_penalty',
                label: 'Repeat Penalty',
                step: 0.01, min: 1, max: 2, defaultVal: 1.0,
                help: 'Penalises recently generated tokens to discourage repetition. 1.0 disables the penalty (default). Values above 1.0 reduce looping; values below 1.0 encourage repetition.',
              },
            ].map(({ key, label, step, min, max, defaultVal, help }) => (
              <label key={key} className="block">
                <HelpLabel label={label} help={help} />
                <input
                  type="number"
                  step={step}
                  min={min}
                  max={max}
                  value={data[key] ?? defaultVal}
                  onChange={e => {
                    const v = parseFloat(e.target.value)
                    handleChange(key, isNaN(v) ? defaultVal : v)
                  }}
                  className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                />
              </label>
            ))}
          </div>
        )}

        {/* Human Review files section */}
        {node.type === 'humanReview' && renderReviewApproval()}
        {node.type === 'humanReview' && renderHumanReviewSection()}
        {node.type === 'outputsReport' && renderReportSection()}

        {/* Input section — shown for all analysis blocks */}
        {ANALYSIS_NODE_TYPES.has(node.type) && renderInputSection()}

        {(node.type === 'sourceAnalysis') && (
          <>
            {/* Unit of Analysis */}
            <div className="block">
              <HelpLabel label="Unit of Analysis" help="Granularity at which the LLM evaluates each chunk of text. Sentence and Paragraph suit narrative text. Row/Column suits spreadsheets. Whole Document sends the full text as one unit." />
              <div className="mt-2 grid grid-cols-2 gap-1">
                {[
                  { value: 'sentence', label: 'Sentence' },
                  { value: 'paragraph', label: 'Paragraph' },
                  { value: 'document', label: 'Whole Document' },
                  { value: 'line', label: 'Row / Column' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name={`unit_type_${node.id}`}
                      value={opt.value}
                      checked={(data.unit_type || 'sentence') === opt.value}
                      onChange={() => handleChange('unit_type', opt.value)}
                      className="text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Data Source section */}
            <div className="block">
              <HelpLabel label="Data Source" help="Choose which documents to analyse. 'All Documents' uses the entire corpus. 'Single Document' targets one file. 'Folder of Documents' targets an uploaded folder collection." />
              <div className="mt-2 space-y-1">
                {[
                  { value: 'all', label: 'All Documents' },
                  { value: 'single', label: 'Single Document' },
                  { value: 'folder', label: 'Folder of Documents' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`source_type_${node.id}`}
                      value={opt.value}
                      checked={(data.source_type || 'all') === opt.value}
                      onChange={() => {
                        const updated = {
                          ...data,
                          source_type: opt.value,
                          source_doc_index: undefined,
                          source_doc_label: undefined,
                          source_folder_name: undefined,
                          selected_columns: [],
                          sentence_column: undefined,
                          sentence_split_method: undefined,
                          sentence_split_delimiter: undefined,
                          sentence_split_delimiters: undefined,
                          unit_type: 'sentence',
                        }
                        setData(updated)
                        onUpdate(updated)
                      }}
                      className="text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>

              {(data.source_type || 'all') === 'single' && (
                <div className="mt-2 space-y-2">
                  {/* Selected file chip */}
                  {data.source_doc_label && (
                    <div className="flex items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 rounded px-2 py-1">
                      <span className="text-xs text-indigo-700 truncate">&#128196; {data.source_doc_label}</span>
                      <button
                        onClick={() => {
                          const updated = {
                            ...data,
                            source_doc_index: undefined,
                            source_doc_label: undefined,
                            selected_columns: [],
                            sentence_column: undefined,
                            sentence_split_method: undefined,
                            sentence_split_delimiter: undefined,
                            sentence_split_delimiters: undefined,
                            unit_type: 'sentence',
                          }
                          setData(updated)
                          onUpdate(updated)
                          setDocColumns([])
                        }}
                        className="shrink-0 text-xs text-indigo-400 hover:text-red-500"
                        title="Remove file selection"
                      >
                        &#x2715;
                      </button>
                    </div>
                  )}

                  <select
                    value={data.source_doc_index ?? ''}
                    onChange={(e) => {
                      const idx = parseInt(e.target.value)
                      const doc = docList.find(d => d.doc_index === idx)
                      const isTabular = /\.(csv|xlsx|xls|numbers)$/i.test(doc?.filename || '')
                      const updated = {
                        ...data,
                        source_doc_index: idx,
                        source_doc_label: doc?.filename || '',
                        selected_columns: [],
                        sentence_column: undefined,
                        sentence_split_method: undefined,
                        sentence_split_delimiter: undefined,
                        sentence_split_delimiters: undefined,
                        context_window: isTabular ? 0 : data.context_window,
                        unit_type: isTabular ? 'line' : 'sentence',
                      }
                      setData(updated)
                      onUpdate(updated)
                    }}
                    className="w-full px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
                  >
                    <option value="">— Select document —</option>
                    {docList.map(doc => (
                      <option key={doc.doc_index} value={doc.doc_index}>{doc.filename}</option>
                    ))}
                  </select>
                </div>
              )}

              {(data.source_type || 'all') === 'folder' && (
                <div className="mt-2">
                  <select
                    value={data.source_folder_name || ''}
                    onChange={(e) => handleChange('source_folder_name', e.target.value)}
                    className="w-full mt-1 px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
                  >
                    <option value="">— Select folder —</option>
                    {folderList.map(f => (
                      <option key={f.folder_name} value={f.folder_name}>{f.folder_name} ({f.doc_indices.length} docs)</option>
                    ))}
                  </select>
                </div>
              )}

              {docColumns.length > 0 && (
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500 font-medium">Select a Specific Column</span>
                    {(data.selected_columns || []).length > 0 && (
                      <button onClick={clearColumnSelection} className="text-xs text-gray-400 hover:text-gray-700">
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-gray-400 text-xs mb-1">None selected = all columns included</p>
                  <div className="max-h-36 overflow-y-auto border border-gray-300 rounded p-2 space-y-1">
                    {docColumns.map(col => (
                      <label key={col} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(data.selected_columns || []).includes(col)}
                          onChange={() => toggleColumn(col)}
                          className="rounded border-gray-300 bg-gray-50 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-gray-900 text-xs truncate">{col}</span>
                      </label>
                    ))}
                  </div>
                  <ColumnGranularityControl nodeId={node.id} projectId={projectId} data={data} handleChange={handleChange} setData={setData} onUpdate={onUpdate} />
                </div>
              )}
            </div>

            <ContextWindowControl nodeId={node.id} data={data} handleChange={handleChange} />

            <label className="block">
              <HelpLabel label="Detection Prompt" help="Prompt sent to the LLM to decide if each text unit is relevant to your research question. The LLM responds TRUE or FALSE." />
              <textarea
                value={data.detection_prompt || ''}
                onChange={(e) => handleChange('detection_prompt', e.target.value)}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                rows={4}
                placeholder="What is QUAILS looking for?"
              />
            </label>
            <label className="block">
              <HelpLabel label="Label Prompt" help="Prompt sent to the LLM to assign a descriptive label (code/tag) to each relevant unit. Only units that passed detection are labeled." />
              <textarea
                value={data.label_prompt || ''}
                onChange={(e) => handleChange('label_prompt', e.target.value)}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                rows={4}
                placeholder="What and how should QUAILS label?"
              />
            </label>
            <label className="block">
              <HelpLabel label="Detection Threshold (%)" help="Minimum confidence for a unit to be marked as relevant. Overrides the project-level default for this block." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={data.detection_threshold || 70}
                onChange={(e) => handleChange('detection_threshold', parseFloat(e.target.value))}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <label className="block">
              <HelpLabel label="Label Threshold (%)" help="Minimum confidence for a label to be accepted. Overrides the project-level default for this block." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={data.label_threshold || 70}
                onChange={(e) => handleChange('label_threshold', parseFloat(e.target.value))}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
          </>
        )}

        {node.type === 'rubricAnalysis' && (
          <>
            {/* Unit of Analysis */}
            <div className="block">
              <HelpLabel label="Unit of Analysis" help="Granularity at which the LLM evaluates each chunk of text. Sentence and Paragraph suit narrative text. Row/Column suits spreadsheets. Whole Document sends the full text as one unit." />
              <div className="mt-2 grid grid-cols-2 gap-1">
                {[
                  { value: 'sentence', label: 'Sentence' },
                  { value: 'paragraph', label: 'Paragraph' },
                  { value: 'document', label: 'Whole Document' },
                  { value: 'line', label: 'Row / Column' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name={`unit_type_${node.id}`}
                      value={opt.value}
                      checked={(data.unit_type || 'sentence') === opt.value}
                      onChange={() => handleChange('unit_type', opt.value)}
                      className="text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Data Source section */}
            <div className="block">
              <HelpLabel label="Data Source" help="Choose which documents to analyse. 'All Documents' uses the entire corpus. 'Single Document' targets one file. 'Folder of Documents' targets an uploaded folder collection." />
              <div className="mt-2 space-y-1">
                {[
                  { value: 'all', label: 'All Documents' },
                  { value: 'single', label: 'Single Document' },
                  { value: 'folder', label: 'Folder of Documents' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`source_type_${node.id}`}
                      value={opt.value}
                      checked={(data.source_type || 'all') === opt.value}
                      onChange={() => {
                        const updated = {
                          ...data,
                          source_type: opt.value,
                          source_doc_index: undefined,
                          source_doc_label: undefined,
                          source_folder_name: undefined,
                          selected_columns: [],
                          sentence_column: undefined,
                          sentence_split_method: undefined,
                          sentence_split_delimiter: undefined,
                          sentence_split_delimiters: undefined,
                          unit_type: 'sentence',
                        }
                        setData(updated)
                        onUpdate(updated)
                      }}
                      className="text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>

              {(data.source_type || 'all') === 'single' && (
                <div className="mt-2 space-y-2">
                  {data.source_doc_label && (
                    <div className="flex items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 rounded px-2 py-1">
                      <span className="text-xs text-indigo-700 truncate">&#128196; {data.source_doc_label}</span>
                      <button
                        onClick={() => {
                          const updated = {
                            ...data,
                            source_doc_index: undefined,
                            source_doc_label: undefined,
                            selected_columns: [],
                            sentence_column: undefined,
                            sentence_split_method: undefined,
                            sentence_split_delimiter: undefined,
                            sentence_split_delimiters: undefined,
                            unit_type: 'sentence',
                          }
                          setData(updated)
                          onUpdate(updated)
                          setDocColumns([])
                        }}
                        className="shrink-0 text-xs text-indigo-400 hover:text-red-500"
                        title="Remove file selection"
                      >
                        &#x2715;
                      </button>
                    </div>
                  )}

                  <select
                    value={data.source_doc_index ?? ''}
                    onChange={(e) => {
                      const idx = parseInt(e.target.value)
                      const doc = docList.find(d => d.doc_index === idx)
                      const isTabular = /\.(csv|xlsx|xls|numbers)$/i.test(doc?.filename || '')
                      const updated = {
                        ...data,
                        source_doc_index: idx,
                        source_doc_label: doc?.filename || '',
                        selected_columns: [],
                        sentence_column: undefined,
                        sentence_split_method: undefined,
                        sentence_split_delimiter: undefined,
                        sentence_split_delimiters: undefined,
                        context_window: isTabular ? 0 : data.context_window,
                        unit_type: isTabular ? 'line' : 'sentence',
                      }
                      setData(updated)
                      onUpdate(updated)
                    }}
                    className="w-full px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
                  >
                    <option value="">— Select document —</option>
                    {docList.map(doc => (
                      <option key={doc.doc_index} value={doc.doc_index}>{doc.filename}</option>
                    ))}
                  </select>
                </div>
              )}

              {(data.source_type || 'all') === 'folder' && (
                <div className="mt-2">
                  <select
                    value={data.source_folder_name || ''}
                    onChange={(e) => handleChange('source_folder_name', e.target.value)}
                    className="w-full mt-1 px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
                  >
                    <option value="">— Select folder —</option>
                    {folderList.map(f => (
                      <option key={f.folder_name} value={f.folder_name}>{f.folder_name} ({f.doc_indices.length} docs)</option>
                    ))}
                  </select>
                </div>
              )}

              {docColumns.length > 0 && (
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500 font-medium">Select a Specific Column</span>
                    {(data.selected_columns || []).length > 0 && (
                      <button onClick={clearColumnSelection} className="text-xs text-gray-400 hover:text-gray-700">
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-gray-400 text-xs mb-1">None selected = all columns included</p>
                  <div className="max-h-36 overflow-y-auto border border-gray-300 rounded p-2 space-y-1">
                    {docColumns.map(col => (
                      <label key={col} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(data.selected_columns || []).includes(col)}
                          onChange={() => toggleColumn(col)}
                          className="rounded border-gray-300 bg-gray-50 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-gray-900 text-xs truncate">{col}</span>
                      </label>
                    ))}
                  </div>
                  <ColumnGranularityControl nodeId={node.id} projectId={projectId} data={data} handleChange={handleChange} setData={setData} onUpdate={onUpdate} />
                </div>
              )}
            </div>

            <ContextWindowControl nodeId={node.id} data={data} handleChange={handleChange} />

            {/* Rubric Items */}
            <div className="block">
              <HelpLabel label="Rubric Items" help="Each rubric item runs independently against every text unit." />
              <div className="mt-2 space-y-3">
                {(data.rubric_items || []).map((item, idx) => (
                  <div key={idx} className="border border-gray-200 rounded p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <input
                        type="text"
                        value={item.title || ''}
                        onChange={(e) => updateRubricItem(idx, 'title', e.target.value)}
                        className="text-xs font-semibold text-gray-700 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-400 focus:outline-none w-full mr-2"
                        placeholder={`Rubric Item ${idx + 1}`}
                      />
                      <button
                        onClick={() => setDeleteRubricIndex(idx)}
                        className="shrink-0 text-xs text-red-400 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                    <label className="block">
                      <HelpLabel label="Description" help="A brief description of what this rubric item measures. Sent to the LLM alongside the scoring criteria to provide context." />
                      <textarea
                        value={item.description || ''}
                        onChange={(e) => updateRubricItem(idx, 'description', e.target.value)}
                        className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                        rows={2}
                        placeholder="e.g. Measures whether the student demonstrates understanding of the concept..."
                      />
                    </label>
                    <label className="block">
                      <HelpLabel label="Scoring Criteria" help="Provide the full scoring criteria for this rubric item. Include what a 0 or null score means (no evidence / not applicable), as well as the criteria for each positive score level (e.g. 1 = partial evidence, 2 = fully present). The LLM will assign a score and provide a justification for every text unit." />
                      <textarea
                        value={item.scoring_prompt || ''}
                        onChange={(e) => updateRubricItem(idx, 'scoring_prompt', e.target.value)}
                        className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                        rows={3}
                        placeholder="e.g. Score 0: no evidence present. Score 1: partial evidence. Score 2: clearly present..."
                      />
                    </label>
                  </div>
                ))}
                <button
                  onClick={addRubricItem}
                  className="w-full px-3 py-1.5 text-xs text-indigo-600 border border-indigo-300 border-dashed rounded hover:bg-indigo-50"
                >
                  ＋ Add Rubric Item
                </button>
              </div>
            </div>

            <label className="block">
              <HelpLabel label="Label Threshold (%)" help="Minimum confidence for a score to be recorded. If confidence falls below this threshold, the score is left blank in the output (confidence and justification are still recorded). Applies per rubric item." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={data.label_threshold || 70}
                onChange={(e) => handleChange('label_threshold', parseFloat(e.target.value))}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
          </>
        )}

        {(node.type === 'sourceAnalysis' || node.type === 'rubricAnalysis') && (
          <label className="block">
            <HelpLabel label="Notes" help="A scratchpad for your own notes about this block — observations, decisions, things to revisit. This is for your reference only and does not affect the analysis." />
            <textarea
              value={data.notes || ''}
              onChange={(e) => handleChange('notes', e.target.value)}
              className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              rows={3}
              placeholder="Jot notes about this block..."
            />
          </label>
        )}

        {node.type === 'themeIdent' && (
          <>
            <label className="block">
              <HelpLabel label="Theme Threshold (%)" help="Minimum confidence for assigning a label to a theme. Overrides the project-level default for this block." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={data.theme_threshold || 80}
                onChange={(e) => handleChange('theme_threshold', parseFloat(e.target.value))}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
          </>
        )}

        {node.type === 'categoryBuild' && (
          <>
            <label className="block">
              <HelpLabel label="Max Categories" help="Maximum number of categories to create. Themes are grouped into up to this many. Overrides the project-level default." />
              <input
                type="number"
                min="1"
                max="20"
                value={data.max_categories || 6}
                onChange={(e) => handleChange('max_categories', parseInt(e.target.value))}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
          </>
        )}

        {node.type === 'customPrompt' && (
          <>
            <label className="block">
              <HelpLabel label="Custom Prompt" help="Your custom prompt text sent to the LLM. Use this for any analysis task not covered by the built-in block types." />
              <textarea
                value={data.prompt || ''}
                onChange={(e) => handleChange('prompt', e.target.value)}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
                rows={6}
              />
            </label>
            <label className="block">
              <HelpLabel label="Output Format" help="Format of the output file. Markdown produces a formatted report; Plain Text produces raw text output." />
              <select
                value={data.output_format || 'markdown'}
                onChange={(e) => handleChange('output_format', e.target.value)}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              >
                <option value="markdown">Markdown</option>
                <option value="text">Plain Text</option>
              </select>
            </label>
          </>
        )}

        {/* Output section — shown for all analysis blocks */}
        {renderOutputSection()}

        <div className="pt-4 mt-4 border-t border-gray-200">
          <button
            onClick={() => { setShowDeleteConfirm(true); setDeleteInput('') }}
            className="w-full px-3 py-2 text-sm bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition-colors"
          >
            Delete Block
          </button>
        </div>
      </div>

      {deleteRubricIndex !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-gray-900 font-semibold text-lg">Remove Rubric Item</h3>
            <p className="text-gray-600 mt-2">
              Are you sure you want to delete rubric item {deleteRubricIndex + 1}? This is irreversible.
            </p>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setDeleteRubricIndex(null)} className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
              <button onClick={() => removeRubricItem(deleteRubricIndex)} className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-500">Remove Item</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-gray-900 font-semibold text-lg">Delete Block</h3>
            <p className="text-gray-600 mt-2">
              Are you sure you want to delete <strong className="text-gray-900">{data.label || node.id}</strong>?
              This will remove the block and all its connections. This action is irreversible.
            </p>
            <p className="text-gray-600 mt-3 text-sm">
              Type <strong className="text-red-600">DELETE</strong> to confirm:
            </p>
            <input
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              className="w-full mt-2 px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-red-500"
              placeholder="Type DELETE to confirm"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => { if (deleteInput === 'DELETE') onDelete() }}
                disabled={deleteInput !== 'DELETE'}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete Block
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
