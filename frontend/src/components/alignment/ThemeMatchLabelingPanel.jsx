import { useState } from 'react'
import { saveSingleLabel } from '../../api'
import HelpLabel from '../common/HelpLabel'

function ThemeMatchRow({ unit, themeReferenceList, projectId, testId, existingLabel, onLabelSaved, onDraftChange }) {
  const [themeChoice, setThemeChoice] = useState(existingLabel?.theme_choice || '')
  const [rationale, setRationale] = useState(existingLabel?.rationale || '')
  const [saveState, setSaveState] = useState('idle')

  function handleChange(value) {
    setThemeChoice(value)
    setSaveState('idle')
    if (onDraftChange) onDraftChange(unit.unit_id, { theme_choice: value, rationale: rationale.trim() })
  }

  function handleRationaleChange(value) {
    setRationale(value)
    setSaveState('idle')
    if (themeChoice && onDraftChange) onDraftChange(unit.unit_id, { theme_choice: themeChoice, rationale: value.trim() })
  }

  async function handleSave() {
    setSaveState('saving')
    const labelData = { theme_choice: themeChoice, rationale: rationale.trim() }
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
        </div>
        <div className="flex flex-col gap-1.5 shrink-0 w-64">
          <HelpLabel
            label="Matching Theme"
            help="Which established theme does this label belong to? Choose 'New theme' if none of the existing themes fit."
          />
          <select
            value={themeChoice}
            onChange={(e) => handleChange(e.target.value)}
            className="px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
          >
            <option value="">-- Select --</option>
            {themeReferenceList.map(t => (
              <option key={t.theme_id} value={t.theme_id}>{t.theme_id}: {t.theme_title}</option>
            ))}
            <option value="NEW">New theme (none of the above fit)</option>
          </select>
          <HelpLabel
            label="Rationale (optional)"
            help="Why did you choose this? Optional. Not used in any alignment statistic — it is saved with your codes so it can inform prompt improvement later."
          />
          <textarea
            value={rationale}
            onChange={(e) => handleRationaleChange(e.target.value)}
            rows={2}
            placeholder="Why this theme?"
            className="px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saveState === 'saving' || !themeChoice}
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

export default function ThemeMatchLabelingPanel({
  projectId,
  sampleUnits,
  themeReferenceList,
  testId,
  humanLabels,
  onHumanLabelsChange,
  onSaveTest,
  onRunComparison,
  autosaveStatus,
  isRunning,
}) {
  function handleLabelChange(unitId, labelData) {
    onHumanLabelsChange(prev => ({ ...prev, [unitId]: labelData }))
  }

  const labeledCount = Object.keys(humanLabels || {}).length

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-xs text-amber-900">
        <p className="font-medium mb-1">Basic v1 alignment mode for Theme Identification</p>
        <p>
          Theme Identification normally compares each row against a theme list that grows sequentially as it
          processes your data. This alignment check instead freezes the theme list from this block's last completed
          run ({themeReferenceList.length} established theme{themeReferenceList.length === 1 ? '' : 's'}) and checks
          each sampled row against it — a useful approximation, but not identical to a live run. Full sequential
          replay is planned for a future update.
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900 leading-relaxed">
        <p className="font-medium mb-1">Your task: for each row below, choose which established theme it belongs to.</p>
        <p>If none of the listed themes fit, select "New theme."</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-600 text-sm font-medium">
            Sample Rows ({labeledCount} / {sampleUnits.length} labeled)
          </span>
        </div>
        <div className="space-y-2 max-h-[calc(100vh-260px)] min-h-[400px] overflow-y-auto pr-1">
          {sampleUnits.map((unit, idx) => {
            const existing = humanLabels?.[unit.unit_id]
            return (
              <div key={unit.unit_id} className="mb-2">
                <div className="text-xs font-semibold text-indigo-600 mb-1 px-1">
                  Sample {idx + 1} / {sampleUnits.length}
                </div>
                <ThemeMatchRow
                  unit={unit}
                  themeReferenceList={themeReferenceList}
                  projectId={projectId}
                  testId={testId}
                  existingLabel={existing}
                  onLabelSaved={handleLabelChange}
                  onDraftChange={handleLabelChange}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSaveTest}
          className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
        >
          Save All
        </button>
        <button
          onClick={onRunComparison}
          disabled={isRunning || labeledCount === 0}
          className="px-4 py-2 text-sm font-medium bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors"
        >
          {isRunning ? 'Running...' : 'Run Alignment Comparison'}
        </button>
        <span className="text-xs text-gray-500">
          {autosaveStatus === 'saving' && 'Saving…'}
          {autosaveStatus === 'saved' && 'All changes saved'}
          {autosaveStatus === 'error' && (
            <span className="text-red-600">Autosave failed — click Save All to retry</span>
          )}
        </span>
      </div>
    </div>
  )
}
