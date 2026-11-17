import { useState } from 'react'
import { saveSingleLabel } from '../../api'
import HelpLabel from '../common/HelpLabel'

export default function SourceLabelingRow({ unit, projectId, testId, existingLabel, onLabelSaved, onDraftChange }) {
  const [detection, setDetection] = useState(existingLabel?.detection || '')
  const [labels, setLabels] = useState(existingLabel?.labels?.join(', ') || '')
  const [rationale, setRationale] = useState(existingLabel?.rationale || '')
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error

  function buildLabelData(det, lbls, why = rationale) {
    return {
      detection: det || 'TRUE',
      labels: lbls.split(',').map(l => l.trim()).filter(Boolean),
      rubric_scores: null,
      rationale: why.trim(),
    }
  }

  function handleRationaleChange(value) {
    setRationale(value)
    setSaveState('idle')
    // Only sync upward once a score exists, so a rationale alone never counts as a labeled case
    if (detection && onDraftChange) onDraftChange(unit.unit_id, buildLabelData(detection, labels, value))
  }

  function handleDetectionChange(value) {
    setDetection(value)
    setSaveState('idle')
    if (onDraftChange) onDraftChange(unit.unit_id, buildLabelData(value, labels))
  }

  function handleLabelsChange(value) {
    setLabels(value)
    setSaveState('idle')
    if (onDraftChange) onDraftChange(unit.unit_id, buildLabelData(detection, value))
  }

  async function handleSave() {
    setSaveState('saving')
    const labelData = buildLabelData(detection, labels)
    try {
      await saveSingleLabel(projectId, testId, unit.unit_id, labelData)
      if (onLabelSaved) onLabelSaved(unit.unit_id, labelData)
      setSaveState('saved')
    } catch (err) {
      console.error('Save failed:', err)
      setSaveState('error')
    }
  }

  return (
    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[11px] text-gray-400 mb-1">{unit.unit_id}</div>
          <div className="text-gray-900 text-sm leading-relaxed">{unit.text}</div>
          {unit.context_before && (
            <div className="text-gray-400 text-xs mt-1 italic">Before: {unit.context_before}</div>
          )}
          {unit.context_after && (
            <div className="text-gray-400 text-xs mt-0.5 italic">After: {unit.context_after}</div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 shrink-0 w-56">
          <HelpLabel
            label="Detection"
            help="Is the analysis goal present in this text? Select TRUE if relevant, FALSE if not."
          />
          <select
            value={detection}
            onChange={(e) => handleDetectionChange(e.target.value)}
            className="px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
          >
            <option value="">--</option>
            <option value="TRUE">TRUE (goal is present)</option>
            <option value="FALSE">FALSE (not present)</option>
          </select>
          {detection === 'TRUE' && (
            <>
              <HelpLabel
                label="Labels"
                help="Enter your own descriptive codes for this text. Separate multiple labels with commas (e.g., engagement, curiosity)."
              />
              <input
                value={labels}
                onChange={(e) => handleLabelsChange(e.target.value)}
                placeholder="e.g., engagement, curiosity"
                className="px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
              />
            </>
          )}
          <HelpLabel
            label="Rationale (optional)"
            help="Why did you choose this? Optional. Not used in any alignment statistic — it is saved with your codes so it can inform prompt improvement later."
          />
          <textarea
            value={rationale}
            onChange={(e) => handleRationaleChange(e.target.value)}
            rows={2}
            placeholder="Why this code?"
            className="px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saveState === 'saving' || !detection}
              className={`px-2 py-1 text-xs rounded disabled:opacity-50 transition-colors ${
                saveState === 'error' ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
              } text-white`}
            >
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Retry Save' : 'Save'}
            </button>
            {saveState === 'saved' && <span className="text-emerald-600 text-xs">Saved ✓</span>}
            {saveState === 'error' && <span className="text-red-600 text-xs">Save failed</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
