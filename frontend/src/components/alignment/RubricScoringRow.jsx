import { useState } from 'react'
import { saveSingleLabel } from '../../api'
import HelpLabel from '../common/HelpLabel'

export default function RubricScoringRow({ unit, rubricItems, projectId, testId, existingLabel, onLabelSaved, onDraftChange }) {
  const [scores, setScores] = useState(() => {
    const s = {}
    if (existingLabel?.rubric_scores) {
      Object.assign(s, existingLabel.rubric_scores)
    }
    return s
  })
  const [rationales, setRationales] = useState(() => ({ ...(existingLabel?.rubric_rationales || {}) }))
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error

  function handleScoreChange(rubricKey, value) {
    setScores(prev => {
      const next = { ...prev, [rubricKey]: value }
      setSaveState('idle')
      if (onDraftChange) onDraftChange(unit.unit_id, buildLabelData(next, rationales))
      return next
    })
  }

  function buildLabelData(sc, rat) {
    const cleaned = {}
    Object.entries(rat).forEach(([k, v]) => { if (v && v.trim()) cleaned[k] = v.trim() })
    return { detection: null, labels: null, rubric_scores: sc, rubric_rationales: cleaned }
  }

  function handleRationaleChange(rubricKey, value) {
    const next = { ...rationales, [rubricKey]: value }
    setRationales(next)
    setSaveState('idle')
    // Only sync upward once at least one score exists
    if (Object.values(scores).some(v => v !== '' && v != null) && onDraftChange) {
      onDraftChange(unit.unit_id, buildLabelData(scores, next))
    }
  }

  async function handleSave() {
    setSaveState('saving')
    const labelData = buildLabelData(scores, rationales)
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
      <div className="font-mono text-[11px] text-gray-400 mb-1">{unit.unit_id}</div>
      <div className="text-gray-900 text-sm leading-relaxed mb-2">{unit.text}</div>
      {unit.context_before && (
        <div className="text-gray-400 text-xs mb-1 italic">Before: {unit.context_before}</div>
      )}
      {unit.context_after && (
        <div className="text-gray-400 text-xs mb-2 italic">After: {unit.context_after}</div>
      )}
      <div className="flex flex-wrap gap-3 items-end">
        {(rubricItems || []).map((item, idx) => {
          const key = `rubric_${idx + 1}`
          return (
            <label key={key} className="block">
              <HelpLabel
                label={item.title || `Rubric ${idx + 1}`}
                help={item.description
                  ? `Score this unit on: ${item.description}`
                  : `Enter a numeric score for this rubric item based on the scoring criteria in the prompts above.`}
              />
              <input
                type="number"
                value={scores[key] ?? ''}
                onChange={(e) => handleScoreChange(key, e.target.value)}
                className="block mt-1 w-16 px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
                placeholder="0"
              />
              <input
                type="text"
                value={rationales[key] ?? ''}
                onChange={(e) => handleRationaleChange(key, e.target.value)}
                className="block mt-1 w-40 px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
                placeholder="Rationale (optional)"
                title="Why did you choose this? Optional. Not used in any alignment statistic — it is saved with your codes so it can inform prompt improvement later."
              />
            </label>
          )
        })}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saveState === 'saving'}
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
  )
}
