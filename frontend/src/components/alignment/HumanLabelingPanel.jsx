import { useState, useRef } from 'react'
import SourceLabelingRow from './SourceLabelingRow'
import RubricScoringRow from './RubricScoringRow'
import HelpLabel from '../common/HelpLabel'

export default function HumanLabelingPanel({
  projectId,
  block,
  sampleUnits,
  testId,
  humanLabels,
  onHumanLabelsChange,
  similarityThreshold,
  onSimilarityThresholdChange,
  rubricMatchMode,
  onRubricMatchModeChange,
  onSaveTest,
  onRunComparison,
  autosaveStatus,
  isRunning,
}) {
  // Shared by both the row's own explicit "Save" click and by live typing
  // (which feeds the panel-level debounced autosave) — same update either way.
  function handleLabelChange(unitId, labelData) {
    onHumanLabelsChange(prev => ({ ...prev, [unitId]: labelData }))
  }

  const labeledCount = Object.keys(humanLabels || {}).length
  const listRef = useRef(null)
  const [savingAll, setSavingAll] = useState(false)
  const [saveAllMsg, setSaveAllMsg] = useState('')

  // Explicit confirmation on top of the ambient autosave status, so clicking
  // "Save All" gives immediate, specific feedback ("Saved 7 of 20 scores")
  // rather than just the generic "All changes saved" a moment later.
  async function handleSaveAllClick() {
    setSavingAll(true)
    setSaveAllMsg('')
    try {
      await onSaveTest()
      setSaveAllMsg(`Saved ${labeledCount} of ${sampleUnits.length} scores.`)
    } finally {
      setSavingAll(false)
    }
    setTimeout(() => setSaveAllMsg(''), 4000)
  }

  function scrollList(direction) {
    if (!listRef.current) return
    const amount = listRef.current.clientHeight * 0.75
    listRef.current.scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'smooth' })
  }

  return (
    <div className="space-y-4">
      {/* Human coding instructions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900 leading-relaxed">
        <p className="font-medium mb-2">Your task: code each text unit below as a human rater.</p>
        {block.block_type === 'sourceAnalysis' ? (
          <>
            <p className="mb-1">
              For each unit, read the text carefully and decide whether the goal described in the prompts above is <strong>present</strong> in the data.
              Select <strong>TRUE</strong> if the content is relevant to the analysis goal, or <strong>FALSE</strong> if it is not.
            </p>
            <p>
              If you select TRUE, also provide one or more <strong>labels</strong> that describe how you would code this unit based on your
              own reading of the text. Separate multiple labels with commas (e.g., "engagement, curiosity"). These labels will be compared
              against the AI's labels to measure alignment.
            </p>
          </>
        ) : (
          <>
            <p className="mb-1">
              For each unit, read the text carefully and assign a <strong>numeric score</strong> for every rubric item listed.
              Use the scoring criteria described in the rubric prompts above to guide your ratings.
            </p>
            <p>
              Enter a whole number for each rubric item. Your scores will be compared side-by-side against the AI's scores
              to measure how closely the AI's judgments match your own.
            </p>
          </>
        )}
      </div>

      {/* Units list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-600 text-sm font-medium">
            Sample Units ({labeledCount} / {sampleUnits.length} labeled)
          </span>
        </div>
        <div
          ref={listRef}
          data-alignment-list=""
          className="space-y-2 max-h-[calc(100vh-200px)] min-h-[700px] overflow-y-auto pr-1"
          style={{ scrollbarWidth: 'auto', scrollbarColor: '#6366f1 #e5e7eb' }}
        >
          <style>{`
            [data-alignment-list]::-webkit-scrollbar { width: 14px; }
            [data-alignment-list]::-webkit-scrollbar-track { background: #e5e7eb; border-radius: 7px; }
            [data-alignment-list]::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 7px; border: 2px solid #e5e7eb; }
            [data-alignment-list]::-webkit-scrollbar-thumb:hover { background: #4f46e5; }
          `}</style>
          {sampleUnits.map((unit, idx) => {
            const existing = humanLabels?.[unit.unit_id]
            return (
              <div key={unit.unit_id} className="mb-2">
                <div className="text-xs font-semibold text-indigo-600 mb-1 px-1">
                  Sample {idx + 1} / {sampleUnits.length}
                </div>
                {block.block_type === 'sourceAnalysis' ? (
                  <SourceLabelingRow
                    unit={unit}
                    projectId={projectId}
                    testId={testId}
                    existingLabel={existing}
                    onLabelSaved={handleLabelChange}
                    onDraftChange={handleLabelChange}
                  />
                ) : (
                  <RubricScoringRow
                    unit={unit}
                    rubricItems={block.rubric_items || block.data?.rubric_items || []}
                    projectId={projectId}
                    testId={testId}
                    existingLabel={existing}
                    onLabelSaved={handleLabelChange}
                    onDraftChange={handleLabelChange}
                  />
                )}
              </div>
            )
          })}
        </div>
        {/* Scroll controls */}
        <div className="flex items-center justify-center gap-3 mt-2">
          <button
            onClick={() => scrollList('up')}
            className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 border border-gray-300 transition-colors"
          >
            Scroll Up
          </button>
          <button
            onClick={() => scrollList('down')}
            className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 border border-gray-300 transition-colors"
          >
            Scroll Down
          </button>
        </div>
      </div>

      {/* Settings row */}
      <div className="flex flex-wrap gap-4 items-end">
        {block.block_type === 'sourceAnalysis' && (
          <label className="block">
            <HelpLabel
              label="Similarity Threshold"
              help="Minimum semantic similarity (0-100) for a human-LLM label pair to count as aligned. Uses GloVe word vectors."
            />
            <input
              type="number"
              min="0"
              max="100"
              value={similarityThreshold}
              onChange={(e) => onSimilarityThresholdChange(parseInt(e.target.value) || 80)}
              className="block mt-1 w-20 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
            />
          </label>
        )}
        {block.block_type === 'rubricAnalysis' && (
          <div>
            <HelpLabel
              label="Match Mode"
              help="Exact: scores must match exactly. Weighted: scores within 1 point count as partial agreement."
            />
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => onRubricMatchModeChange('exact')}
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  rubricMatchMode === 'exact'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Exact
              </button>
              <button
                onClick={() => onRubricMatchModeChange('weighted')}
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  rubricMatchMode === 'weighted'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Weighted
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSaveAllClick}
          disabled={savingAll || labeledCount === 0}
          className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {savingAll ? 'Saving…' : `Save All (${labeledCount}/${sampleUnits.length})`}
        </button>
        <button
          onClick={onRunComparison}
          disabled={isRunning || labeledCount === 0}
          className="px-4 py-2 text-sm font-medium bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors"
        >
          {isRunning ? 'Running...' : 'Run Alignment Comparison'}
        </button>
        <span className="text-xs text-gray-500">
          {saveAllMsg ? (
            <span className="text-emerald-600">{saveAllMsg}</span>
          ) : (
            <>
              {autosaveStatus === 'saving' && 'Saving…'}
              {autosaveStatus === 'saved' && 'All changes saved'}
              {autosaveStatus === 'error' && (
                <span className="text-red-600">Autosave failed — click Save All to retry</span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  )
}
