import { Fragment, useState } from 'react'
import { applyOptimizationCandidate, setActiveModel } from '../../../api'
import HelpLabel from '../../common/HelpLabel'
import { pct, pp, ci, STATE_STYLES, STATE_HELP, wordDiff, promptFields } from './format'

function DiffText({ before, after }) {
  return (
    <div className="text-xs leading-relaxed whitespace-pre-wrap bg-white border border-gray-200 rounded p-2">
      {wordDiff(before, after).map((p, i) => (
        <span key={i} className={p.type === 'add' ? 'bg-emerald-100 text-emerald-900' : p.type === 'del' ? 'bg-red-100 text-red-800 line-through' : ''}>
          {p.text}
        </span>
      ))}
    </div>
  )
}

function ApplyDialog({ projectId, job, cand, onClose, onApplied }) {
  const fields = promptFields(job.block_type, cand.prompts)
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(f => [f.key, f.value])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleApply() {
    setBusy(true)
    setError(null)
    let edits
    if (job.block_type === 'sourceAnalysis') {
      edits = { detection_prompt: values.detection_prompt, label_prompt: values.label_prompt }
    } else {
      edits = {
        rubric_items: (cand.prompts.rubric_items || []).map((it, i) => ({ ...it, scoring_prompt: values[`rubric_${i + 1}`] })),
      }
    }
    try {
      const res = await applyOptimizationCandidate(projectId, job.job_id, cand.id, edits)
      onApplied(res.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Apply failed')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 p-5 max-h-[90vh] overflow-y-auto">
        <h3 className="text-gray-900 font-semibold">Apply {cand.id} to “{job.block_label}”</h3>
        <p className="text-xs text-gray-600 mt-1">
          This replaces the block's prompts in the Analysis Builder (live, saved automatically). You can edit the text first —
          the record will note whether it was applied verbatim or edited, which matters for how you describe the method.
        </p>
        <div className="mt-3 space-y-3">
          {fields.map(f => (
            <div key={f.key}>
              <label className="text-xs font-medium text-gray-700">{f.label}</label>
              <textarea
                value={values[f.key]}
                onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                rows={5}
                className="mt-1 block w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded text-gray-900"
              />
              {values[f.key] !== f.value && <span className="text-[11px] text-amber-700">Edited — will be recorded as human-edited.</span>}
            </div>
          ))}
        </div>
        {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
          <button onClick={handleApply} disabled={busy} className="px-3 py-1.5 text-sm bg-emerald-700 text-white rounded hover:bg-emerald-600 disabled:opacity-50">
            {busy ? 'Applying…' : 'Apply to block'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CandidateLeaderboard({ projectId, job, candidates, onApplyPrompts }) {
  const [expanded, setExpanded] = useState(null)
  const [applying, setApplying] = useState(null)
  const [message, setMessage] = useState(null)
  const models = job.config.eval_models
  const primary = models[0]
  const baseline = candidates.find(c => c.origin === 'baseline')
  const evaluated = candidates.filter(c => Object.keys(c.evaluations || {}).length > 0)
  const rejected = candidates.filter(c => ['unparseable', 'invalid', 'optimizer_error'].includes(c.status))

  function cell(c, m, split = 'dev') {
    return (c.evaluations?.[m] || {})[split]
  }

  async function handleUseModel(m) {
    if (!window.confirm(`Set "${m}" as the active model? This is an app-wide setting (AI Settings) and affects all projects' next runs.`)) return
    try {
      await setActiveModel('ollama', m)
      setMessage(`"${m}" is now the active model.`)
    } catch {
      setMessage('Could not change the active model.')
    }
  }

  function handleApplied(res) {
    onApplyPrompts(res.prompts)
    setApplying(null)
    setMessage(`Applied ${res.verbatim ? 'verbatim' : 'with your edits'} — the block's prompts are updated in the Analysis Builder.`)
  }

  return (
    <div className="space-y-2">
      {message && <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">{message}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1.5 pr-2">Candidate</th>
              {models.map(m => (
                <th key={m} className="py-1.5 pr-2">
                  <div className="font-medium text-gray-700">{m}{m === primary && <span className="ml-1 text-indigo-600">(primary)</span>}</div>
                  <button onClick={() => handleUseModel(m)} className="text-[10px] text-indigo-600 hover:underline">use as active model</button>
                </th>
              ))}
              <th className="py-1.5 pr-2">
                <HelpLabel label="Δ vs parent" help="Paired change in development agreement against the prompt it was revised from, on the primary model, with a 95% bootstrap interval." />
              </th>
              <th className="py-1.5 pr-2">State</th>
              <th className="py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {evaluated.map(c => {
              const isBest = c.id === job.best_candidate_id
              return (
                <Fragment key={c.id}>
                  <tr
                    className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${isBest ? 'bg-emerald-50' : ''}`}
                    onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                  >
                    <td className="py-1.5 pr-2">
                      <div className="font-mono font-medium text-gray-900">{c.id}{isBest && ' ★'}</div>
                      <div className="text-gray-500">{c.origin === 'baseline' ? 'current block prompt' : `round ${c.round} · ${c.focus}`}</div>
                    </td>
                    {models.map(m => {
                      const d = cell(c, m), h = cell(c, m, 'holdout')
                      return (
                        <td key={m} className="py-1.5 pr-2 align-top">
                          {d ? (
                            <>
                              <div className="text-gray-900 font-medium">{pct(d.primary)} <span className="text-gray-400 font-normal">{ci(d.primary_ci)}</span></div>
                              <div className="text-gray-500">
                                {job.block_type === 'sourceAnalysis'
                                  ? `labels ${d.label_similarity == null ? 'n/a' : `${Math.round(d.label_similarity)}%`}`
                                  : `±1 ${pct(d.within_one)}`}
                              </div>
                              {h && <div className="text-indigo-700">holdout {pct(h.primary)}</div>}
                            </>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                      )
                    })}
                    <td className="py-1.5 pr-2 align-top">
                      {c.delta_vs_parent != null ? (
                        <>
                          <div>{pp(c.delta_vs_parent)}</div>
                          <div className="text-gray-400">{ci(c.delta_ci)}</div>
                          {c.flips_vs_parent && <div className="text-gray-500">{c.flips_vs_parent.fixed.length} fixed / {c.flips_vs_parent.broke.length} broken</div>}
                        </>
                      ) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 align-top">
                      {c.state && (
                        <span title={STATE_HELP[c.state] || ''} className={`px-1.5 py-0.5 rounded ${STATE_STYLES[c.state] || 'bg-gray-100'}`}>{c.state}</span>
                      )}
                    </td>
                    <td className="py-1.5 align-top" onClick={e => e.stopPropagation()}>
                      {!job.is_running && (
                        <button onClick={() => setApplying(c)} className="px-2 py-0.5 text-[11px] bg-emerald-50 text-emerald-800 rounded hover:bg-emerald-100">
                          Apply…
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === c.id && (
                    <tr>
                      <td colSpan={models.length + 4} className="bg-gray-50 p-3">
                        <div className="space-y-2 text-xs text-gray-700">
                          {(c.hypotheses || []).length > 0 && (
                            <div>
                              <div className="font-medium text-gray-800 mb-1">
                                Hypotheses {c.cited_with_rationale != null && <span className="font-normal text-gray-500">(grounded in {c.cited_with_rationale} human rationale{c.cited_with_rationale === 1 ? '' : 's'})</span>}
                              </div>
                              <ul className="list-disc pl-5 space-y-1">
                                {c.hypotheses.map((h, i) => (
                                  <li key={i}>
                                    {h.hypothesis}
                                    {h.rationale_quote && <span className="text-gray-500 italic"> — “{h.rationale_quote}”</span>}
                                    {h.evidence_unit_ids?.length > 0 && <span className="text-gray-400 font-mono"> [{h.evidence_unit_ids.join(', ')}]</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {c.diagnosis && <div><span className="font-medium text-gray-800">Diagnosis: </span>{c.diagnosis}</div>}
                          {c.cited_cases_flips && (
                            <div className="text-gray-500">
                              On the cases its hypotheses cited: {c.cited_cases_flips.fixed.length} fixed, {c.cited_cases_flips.broke.length} broken.
                            </div>
                          )}
                          {c.optimizer_prompt_budget && (
                            <div className="text-gray-500">
                              Optimizer saw {c.optimizer_prompt_budget.cases_included} of {c.optimizer_prompt_budget.cases_available} disagreements
                              ({c.optimizer_prompt_budget.cases_with_rationale} with your rationale, {c.optimizer_prompt_budget.anchor_unit_ids?.length || 0} agreeing anchors
                              {c.optimizer_prompt_budget.cases_dropped ? `, ${c.optimizer_prompt_budget.cases_dropped} dropped for context length` : ''}).
                            </div>
                          )}
                          {c.origin !== 'baseline' && baseline && promptFields(job.block_type, c.prompts).map((f, i) => {
                            const before = promptFields(job.block_type, baseline.prompts)[i]?.value
                            if (before === f.value) return null
                            return (
                              <div key={f.key}>
                                <div className="font-medium text-gray-800 mb-0.5">{f.label} — changes vs. current block prompt</div>
                                <DiffText before={before} after={f.value} />
                              </div>
                            )
                          })}
                          {c.origin === 'baseline' && promptFields(job.block_type, c.prompts).map(f => (
                            <div key={f.key}>
                              <div className="font-medium text-gray-800 mb-0.5">{f.label}</div>
                              <div className="whitespace-pre-wrap bg-white border border-gray-200 rounded p-2">{f.value}</div>
                            </div>
                          ))}
                          {(c.normalization_notes || []).length > 0 && (
                            <div className="text-gray-400">Parsing notes: {c.normalization_notes.join(' ')}</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {rejected.length > 0 && (
        <p className="text-xs text-gray-500">
          {rejected.length} proposal{rejected.length === 1 ? ' was' : 's were'} rejected before testing (unparseable, invalid, or optimizer error) — details in the report.
        </p>
      )}
      <p className="text-xs text-gray-500">
        ★ = the working prompt the search ended on (the current block prompt if nothing beat it reliably). Agreement is on the development
        cases unless marked holdout; the holdout estimates how well a prompt generalises to cases the optimizer never saw.
      </p>
      {applying && (
        <ApplyDialog projectId={projectId} job={job} cand={applying} onClose={() => setApplying(null)} onApplied={handleApplied} />
      )}
    </div>
  )
}
