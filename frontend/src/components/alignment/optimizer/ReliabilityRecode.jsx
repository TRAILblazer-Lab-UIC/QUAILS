import { useState } from 'react'
import { startReliability, saveReliabilityLabel, computeReliability } from '../../../api'
import { pct } from './format'

/**
 * Blind re-code of a random 15% of already-coded cases. Agreement with your
 * own earlier codes is the "rater ceiling": no prompt can be expected to agree
 * with you more consistently than you agree with yourself.
 */
export default function ReliabilityRecode({ projectId, testId, block, onComputed }) {
  const [open, setOpen] = useState(false)
  const [units, setUnits] = useState([])
  const [labels, setLabels] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const rubricItems = block?.data?.rubric_items || []
  const isRubric = block?.block_type === 'rubricAnalysis'

  async function handleOpen() {
    setError(null)
    try {
      const res = await startReliability(projectId, testId)
      setUnits(res.data.units || [])
      setLabels(res.data.labels || {})
      setResult(res.data.computed || null)
      setOpen(true)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start the re-code')
    }
  }

  async function setLabel(uid, next) {
    setLabels(prev => ({ ...prev, [uid]: next }))
    try {
      await saveReliabilityLabel(projectId, testId, uid, next)
    } catch {
      setError('Save failed — try again')
    }
  }

  async function handleCompute() {
    setError(null)
    try {
      const res = await computeReliability(projectId, testId)
      setResult(res.data)
      if (onComputed) onComputed(res.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not compute')
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <button onClick={handleOpen} className="px-2 py-1 bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100">
          Measure your own consistency (blind re-code)
        </button>
        {error && <span className="text-red-600">{error}</span>}
      </div>
    )
  }

  return (
    <div className="border border-indigo-200 bg-indigo-50/40 rounded-lg p-3 space-y-2">
      <p className="text-xs text-indigo-900">
        Code these {units.length} case{units.length === 1 ? '' : 's'} again, without looking back at your earlier codes or the AI's output.
        Your agreement with your own earlier codes becomes the <strong>rater ceiling</strong>: the optimizer stops if the AI reaches it,
        because gains beyond your own consistency would be fitting noise.
      </p>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {units.map((u, i) => (
          <div key={u.unit_id} className="bg-white border border-gray-200 rounded p-2">
            <div className="text-[11px] text-indigo-600 font-semibold">Re-code {i + 1} / {units.length}</div>
            <div className="text-sm text-gray-900 my-1">{u.text}</div>
            {isRubric ? (
              <div className="flex flex-wrap gap-3">
                {rubricItems.map((it, idx) => {
                  const key = `rubric_${idx + 1}`
                  const cur = labels[u.unit_id]?.rubric_scores || {}
                  return (
                    <label key={key} className="text-xs text-gray-700">
                      {it.title || `Rubric ${idx + 1}`}
                      <input
                        type="number"
                        value={cur[key] ?? ''}
                        onChange={(e) => setLabel(u.unit_id, { rubric_scores: { ...cur, [key]: e.target.value } })}
                        className="block mt-0.5 w-16 px-2 py-1 border border-gray-300 rounded"
                      />
                    </label>
                  )
                })}
              </div>
            ) : (
              <select
                value={labels[u.unit_id]?.detection || ''}
                onChange={(e) => setLabel(u.unit_id, { detection: e.target.value })}
                className="px-2 py-1 text-xs border border-gray-300 rounded"
              >
                <option value="">--</option>
                <option value="TRUE">TRUE (goal is present)</option>
                <option value="FALSE">FALSE (not present)</option>
              </select>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={handleCompute} className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500">
          Compute my consistency
        </button>
        <button onClick={() => setOpen(false)} className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded">Close</button>
        {result && (
          <span className="text-xs text-gray-700">
            Self-agreement <strong>{pct(result.self_agreement)}</strong> over {result.n} judgement{result.n === 1 ? '' : 's'}
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  )
}
