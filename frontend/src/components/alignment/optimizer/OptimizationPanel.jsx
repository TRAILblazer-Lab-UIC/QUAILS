import { useEffect, useMemo, useState } from 'react'
import {
  getOptimizationModels, estimateOptimization, startOptimization, listOptimizations,
  getOptimization, stopOptimization, resumeOptimization, getOptimizationDisagreements,
  saveRationale, downloadOptimizationReport,
} from '../../../api'
import socket from '../../../socket'
import HelpLabel from '../../common/HelpLabel'
import ReportMenu from '../ReportMenu'
import CandidateLeaderboard from './CandidateLeaderboard'
import ReliabilityRecode from './ReliabilityRecode'
import { modelFamily, pct } from './format'
import ParallelSlotsNote from '../ParallelSlotsNote'

const MIN_LABELED = 10

function isCoded(blockType, label) {
  if (!label) return false
  if (blockType === 'sourceAnalysis') return label.detection === 'TRUE' || label.detection === 'FALSE'
  return Object.values(label.rubric_scores || {}).some(v => v !== '' && v != null)
}

function hasRationale(label) {
  return Boolean(label?.rationale?.trim()) || Object.values(label?.rubric_rationales || {}).some(v => v && v.trim())
}

/** Baseline disagreements without a rationale — the human explains them before the search starts. */
function ExplainDisagreements({ projectId, job, onRationaleSaved, onContinue }) {
  const [cases, setCases] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [saved, setSaved] = useState({})

  useEffect(() => {
    getOptimizationDisagreements(projectId, job.job_id).then(res => setCases(res.data.cases || [])).catch(() => setCases([]))
  }, [projectId, job.job_id])

  async function handleSave(c) {
    const key = c.rubric_key ? `${c.unit_id}::${c.rubric_key}` : c.unit_id
    const res = await saveRationale(projectId, job.test_id, {
      unit_id: c.unit_id, rationale: drafts[key] || '', rubric_key: c.rubric_key, post_hoc: true,
    })
    setSaved(s => ({ ...s, [key]: true }))
    onRationaleSaved(c.unit_id, res.data.label)
  }

  if (cases == null) return <p className="text-sm text-gray-500">Loading disagreements…</p>
  const missing = cases.filter(c => !c.human_rationale)

  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 space-y-3">
      <div className="text-sm text-amber-900">
        <p className="font-medium">Paused: explain the disagreements (optional, but it is the optimizer's best evidence)</p>
        <p className="text-xs mt-1">
          The AI disagreed with you on {cases.length} development case{cases.length === 1 ? '' : 's'}; {missing.length} have no rationale.
          A sentence on <em>why</em> you coded it your way tells the optimizer which rule the prompt is missing.
          These rationales are written after seeing the AI's answer, so they are marked as post-hoc in the record.
          Holdout cases are never shown here.
        </p>
      </div>
      <div className="space-y-2 max-h-[28rem] overflow-y-auto">
        {missing.map(c => {
          const key = c.rubric_key ? `${c.unit_id}::${c.rubric_key}` : c.unit_id
          return (
            <div key={key} className="bg-white border border-gray-200 rounded p-2 text-xs">
              <div className="font-mono text-gray-400">{c.unit_id}{c.rubric_key ? ` · ${c.rubric_title}` : ''}</div>
              <div className="text-sm text-gray-900 my-1">{c.text}</div>
              <div className="grid grid-cols-2 gap-2 text-gray-700">
                <div><span className="font-medium">You:</span> {c.human_decision}{c.human_labels?.length ? ` — ${c.human_labels.join(', ')}` : ''}</div>
                <div>
                  <span className="font-medium">AI:</span> {c.model_decision || '(blank)'} ({Math.round(c.model_confidence || 0)}%)
                  {c.model_labels?.length ? ` — ${c.model_labels.join(', ')}` : ''}
                  {c.model_reasoning && <div className="text-gray-500 italic">{c.model_reasoning}</div>}
                </div>
              </div>
              <div className="flex gap-2 mt-1">
                <textarea
                  rows={2}
                  value={drafts[key] || ''}
                  onChange={(e) => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                  placeholder="Why did you code it this way?"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded"
                />
                <button
                  onClick={() => handleSave(c)}
                  disabled={!(drafts[key] || '').trim()}
                  className="self-start px-2 py-1 bg-emerald-600 text-white rounded disabled:opacity-50"
                >
                  {saved[key] ? 'Saved ✓' : 'Save'}
                </button>
              </div>
            </div>
          )
        })}
        {missing.length === 0 && <p className="text-xs text-gray-600">Every disagreement has a rationale.</p>}
      </div>
      <button onClick={onContinue} className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500">
        Continue the search
      </button>
    </div>
  )
}

export default function OptimizationPanel({ projectId, block, testId, humanLabels, onRationaleSaved, onApplyPrompts }) {
  const blockType = block?.block_type
  const [models, setModels] = useState([])
  const [modelsError, setModelsError] = useState(null)
  const [evalModels, setEvalModels] = useState([])
  const [optimizerModel, setOptimizerModel] = useState('')
  const [rounds, setRounds] = useState(5)
  const [k, setK] = useState(3)
  const [holdoutPct, setHoldoutPct] = useState(30)
  const [noiseFloor, setNoiseFloor] = useState(true)
  const [pauseForRationales, setPauseForRationales] = useState(true)
  const [parallelSlots, setParallelSlots] = useState(1)
  const [estimate, setEstimate] = useState(null)
  const [error, setError] = useState(null)
  const [jobs, setJobs] = useState([])
  const [jobId, setJobId] = useState(null)
  const [jobData, setJobData] = useState(null)
  const [starting, setStarting] = useState(false)

  const labeled = useMemo(() => Object.values(humanLabels || {}).filter(l => isCoded(blockType, l)), [humanLabels, blockType])
  const withRationale = labeled.filter(hasRationale).length
  const config = {
    eval_models: evalModels, optimizer_model: optimizerModel, rounds, candidates_per_round: k,
    holdout_pct: holdoutPct, noise_floor: noiseFloor, pause_for_rationales: pauseForRationales,
    parallel_slots: parallelSlots,
  }
  const sameFamily = optimizerModel && evalModels.some(m => modelFamily(m) === modelFamily(optimizerModel))

  useEffect(() => {
    getOptimizationModels(projectId).then(res => {
      const names = res.data.models || []
      setModels(names)
      setModelsError(res.data.error || (names.length ? null : 'No Ollama models found.'))
    }).catch(() => setModelsError('Could not list Ollama models.'))
  }, [projectId])

  async function refreshJobs(selectLatest = false) {
    try {
      const res = await listOptimizations(projectId, block.block_id)
      setJobs(res.data.jobs || [])
      const running = res.data.running_job_id
      if (running) setJobId(running)
      else if (selectLatest && res.data.jobs?.length) setJobId(res.data.jobs[0].job_id)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    setJobId(null)
    setJobData(null)
    refreshJobs(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, block?.block_id])

  async function loadJob(id = jobId) {
    if (!id) return
    try {
      const res = await getOptimization(projectId, id)
      setJobData(res.data)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadJob() }, [jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: poll while running, and refresh on job socket events.
  const live = jobData?.job?.is_running
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => loadJob(), 3000)
    return () => clearInterval(t)
  }, [live, jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onDone(d) {
      if (d.project_id !== projectId) return
      loadJob(d.job_id)
      refreshJobs()
    }
    socket.on('optimization_complete', onDone)
    socket.on('optimization_waiting', onDone)
    return () => {
      socket.off('optimization_complete', onDone)
      socket.off('optimization_waiting', onDone)
    }
  }, [projectId, jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleEvalModel(m) {
    setEvalModels(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])
    setEstimate(null)
  }

  async function handleEstimate() {
    setError(null)
    try {
      const res = await estimateOptimization(projectId, testId, config)
      setEstimate(res.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Estimate failed')
    }
  }

  async function handleStart() {
    setError(null)
    setStarting(true)
    try {
      const res = await startOptimization(projectId, block.block_id, testId, config)
      setJobId(res.data.job_id)
      await refreshJobs()
      await loadJob(res.data.job_id)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start')
    } finally {
      setStarting(false)
    }
  }


  const job = jobData?.job
  const canStart = testId && labeled.length >= MIN_LABELED && evalModels.length > 0 && optimizerModel && !live

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-700 leading-relaxed">
        Let QUAILS search for better prompt wording automatically. An optimizer model reads the cases where the AI disagreed with you —
        <strong> together with your rationales</strong> — forms hypotheses about what the prompt is missing, and proposes revisions. Each revision is
        re-tested on your coded cases; it only counts as better if the improvement is statistically reliable. A held-out set of your cases
        is never shown to the optimizer and checks whether the winner generalises. Nothing changes your block until you click <em>Apply</em>.
      </div>

      {labeled.length < MIN_LABELED ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Code at least {MIN_LABELED} cases in this test first ({labeled.length} coded so far).
        </p>
      ) : (
        <div className="border border-gray-200 rounded-lg p-3 space-y-3">
          <div className="text-xs text-gray-600">
            {labeled.length} coded cases · <strong>{withRationale}</strong> with a rationale
            {withRationale < labeled.length && ' — rationales are optional, but they are the strongest evidence the optimizer has.'}
          </div>

          <div>
            <HelpLabel label="Models to evaluate" help="Each candidate prompt is tested on every checked model, so you can compare models too. The first one checked is the primary model used to choose between prompts." />
            {modelsError && <p className="text-xs text-red-600">{modelsError}</p>}
            <div className="flex flex-wrap gap-2 mt-1">
              {models.map(m => (
                <label key={m} className={`flex items-center gap-1 text-xs px-2 py-1 rounded border cursor-pointer ${evalModels.includes(m) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'}`}>
                  <input type="checkbox" checked={evalModels.includes(m)} onChange={() => toggleEvalModel(m)} />
                  {m}{evalModels[0] === m && <span className="text-indigo-600"> (primary)</span>}
                </label>
              ))}
            </div>
          </div>

          <div>
            <HelpLabel label="Optimizer model (writes the revisions)" help="Ideally from a different model family than the models being evaluated: a model diagnosing its own mistakes tends to share the blind spot that caused them. This does not protect against overfitting — the holdout does that." />
            <select value={optimizerModel} onChange={(e) => setOptimizerModel(e.target.value)} className="mt-1 px-2 py-1 text-xs border border-gray-300 rounded">
              <option value="">-- choose --</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {sameFamily && <p className="text-xs text-amber-700 mt-1">This looks like the same model family as an evaluated model; a different family is recommended.</p>}
          </div>

          <div className="flex flex-wrap gap-4 text-xs">
            <label>Rounds <input type="number" min={1} max={20} value={rounds} onChange={e => setRounds(Number(e.target.value))} className="ml-1 w-14 px-1 py-0.5 border border-gray-300 rounded" /></label>
            <label>Proposals per round <input type="number" min={1} max={6} value={k} onChange={e => setK(Number(e.target.value))} className="ml-1 w-14 px-1 py-0.5 border border-gray-300 rounded" /></label>
            <label>Holdout % <input type="number" min={10} max={50} value={holdoutPct} onChange={e => setHoldoutPct(Number(e.target.value))} className="ml-1 w-14 px-1 py-0.5 border border-gray-300 rounded" /></label>
            <label title="Throughput mode: several cases evaluated at once. Faster on GPU / unified-memory machines; batching can change results slightly (recorded in the report).">
              Cases in parallel{' '}
              <select value={parallelSlots} onChange={e => setParallelSlots(Number(e.target.value))} className="px-1 py-0.5 border border-gray-300 rounded">
                <option value={1}>1 (replicable)</option><option value={2}>2</option><option value={4}>4</option>
              </select>
            </label>
            {parallelSlots > 1 && <span className="text-xs text-amber-700">Batched evaluations may differ slightly from one-at-a-time runs. <ParallelSlotsNote slots={parallelSlots} /></span>}
            <label className="flex items-center gap-1" title="Runs the current prompt twice to measure run-to-run variation; a revision must beat that to count.">
              <input type="checkbox" checked={noiseFloor} onChange={e => setNoiseFloor(e.target.checked)} /> Measure noise floor
            </label>
            <label className="flex items-center gap-1" title="After testing the current prompt, pause so you can explain disagreements that have no rationale.">
              <input type="checkbox" checked={pauseForRationales} onChange={e => setPauseForRationales(e.target.checked)} /> Pause to explain disagreements
            </label>
          </div>

          <ReliabilityRecode projectId={projectId} testId={testId} block={block} />

          <div className="flex items-center gap-2">
            <button onClick={handleEstimate} disabled={!canStart} className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50">
              Estimate
            </button>
            <button onClick={handleStart} disabled={!canStart || starting} className="px-3 py-1.5 text-sm bg-emerald-700 text-white rounded hover:bg-emerald-600 disabled:opacity-50">
              {starting ? 'Starting…' : 'Start optimization'}
            </button>
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
          {estimate && (
            <p className="text-xs text-gray-600">
              {estimate.dev_cases} development / {estimate.holdout_cases} holdout cases · up to ~{estimate.max_llm_calls} model calls
              (~{estimate.est_minutes} min at {estimate.assumed_seconds_per_call}s/call). {estimate.note}
            </p>
          )}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">Optimization runs:</span>
          <select value={jobId || ''} onChange={e => setJobId(e.target.value)} className="px-2 py-1 border border-gray-300 rounded">
            {jobs.map(j => (
              <option key={j.job_id} value={j.job_id}>
                {j.job_id} — {j.status}{j.final_state ? ` (${j.final_state})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {job && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-gray-900">{job.job_id}</span>
            <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-xs">{job.status}</span>
            {job.final_state && <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 text-xs">{job.final_state}</span>}
            <span className="text-xs text-gray-500">
              round {job.rounds_completed}/{job.config.rounds} · noise floor {pct(job.noise_floor)} · rater ceiling {pct(job.rater_ceiling)}
              · {job.split.dev_ids.length} dev / {job.split.holdout_ids.length} holdout
            </span>
            {job.is_running && (
              <button onClick={() => stopOptimization(projectId, job.job_id).then(() => loadJob())} className="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100">
                Stop
              </button>
            )}
            {!job.is_running && (
              <ReportMenu
                fetcher={(fmt) => downloadOptimizationReport(projectId, job.job_id, fmt)}
                filenameBase={job.job_id}
                label="Download report"
              />
            )}
          </div>
          {job.stop_reason && <p className="text-xs text-gray-600">{job.stop_reason}</p>}
          {job.status === 'awaiting_rationales' && job.is_running && (
            <ExplainDisagreements
              projectId={projectId}
              job={job}
              onRationaleSaved={onRationaleSaved}
              onContinue={() => resumeOptimization(projectId, job.job_id).then(() => loadJob())}
            />
          )}
          {jobData.candidates?.length > 0 && (
            <CandidateLeaderboard projectId={projectId} job={job} candidates={jobData.candidates} onApplyPrompts={onApplyPrompts} />
          )}
        </div>
      )}
    </div>
  )
}
