import { useEffect, useState } from 'react'
import { getHardware, getHardwareFit, getOllamaServer, applyOllamaServer, runBenchmark } from '../../api'
import ConfirmDialog from './ConfirmDialog'

const KIND_LABEL = {
  apple_unified: 'Apple Silicon (unified memory, Metal)',
  nvidia_unified: 'NVIDIA unified memory (e.g. GB10 / DGX Spark / ASUS Ascent GX10)',
  amd_unified: 'AMD unified memory (Ryzen AI Max) — experimental',
  discrete_gpu: 'Discrete GPU',
  cpu: 'CPU only',
}
const STATUS_STYLE = {
  fits: 'bg-emerald-100 text-emerald-800',
  tight: 'bg-amber-100 text-amber-800',
  spills: 'bg-red-100 text-red-700',
  cpu: 'bg-gray-100 text-gray-600',
  unknown: 'bg-gray-100 text-gray-600',
}
const STATUS_LABEL = { fits: 'fits', tight: 'tight', spills: 'spills to CPU', cpu: 'CPU', unknown: 'unknown' }
const VAR_HELP = {
  OLLAMA_NUM_PARALLEL: 'Requests Ollama runs at once. 1 = one at a time (replicable, least memory).',
  OLLAMA_FLASH_ATTENTION: 'Faster, leaner attention on GPU; required for a quantized KV cache.',
  OLLAMA_KV_CACHE_TYPE: 'Precision of the context memory. f16 = full fidelity; q8_0 halves it at a small fidelity cost.',
  OLLAMA_MAX_LOADED_MODELS: 'How many models may stay resident together.',
}

function SettingsTable({ settings, live }) {
  return (
    <table className="w-full text-xs mt-1">
      <tbody>
        {Object.entries(settings).map(([k, v]) => (
          <tr key={k} className="border-b border-gray-100">
            <td className="py-1 pr-2 font-mono text-gray-800">{k}</td>
            <td className="py-1 pr-2 font-mono">
              {v}
              {live && live[k] !== undefined && live[k] !== v && <span className="text-gray-400"> (now {live[k]})</span>}
              {live && live[k] === undefined && <span className="text-gray-400"> (now: Ollama default)</span>}
            </td>
            <td className="py-1 text-gray-500">{VAR_HELP[k]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function HardwarePerformanceCard() {
  const [hw, setHw] = useState(null)
  const [fit, setFit] = useState(null)
  const [server, setServer] = useState(null)
  const [confirm, setConfirm] = useState(null)   // { profileName, settings }
  const [applyResult, setApplyResult] = useState(null)
  const [applying, setApplying] = useState(false)
  const [bench, setBench] = useState(null)
  const [benching, setBenching] = useState(false)
  const [error, setError] = useState(null)

  async function load(refresh = false) {
    setError(null)
    try {
      const [h, f, s] = await Promise.all([getHardware(refresh), getHardwareFit(), getOllamaServer()])
      setHw(h.data)
      setFit(f.data)
      setServer(s.data)
    } catch {
      setError('Could not read hardware information (is the backend running?).')
    }
  }
  useEffect(() => { load() }, [])

  async function handleApply() {
    const { settings } = confirm
    setConfirm(null)
    setApplying(true)
    setApplyResult(null)
    try {
      const res = await applyOllamaServer(settings)
      setApplyResult(res.data)
      await load()
    } catch (err) {
      setApplyResult({ error: err.response?.data?.error || 'Could not apply settings.' })
    } finally {
      setApplying(false)
    }
  }

  async function handleBenchmark() {
    setBenching(true)
    setBench(null)
    try {
      const res = await runBenchmark()
      setBench(res.data)
      load()
    } catch (err) {
      setBench({ error: err.response?.data?.error || 'Benchmark failed (is Ollama running and the model installed?).' })
    } finally {
      setBenching(false)
    }
  }

  if (error) return <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-red-600">{error}</div>
  if (!hw || !fit) return null

  const p = hw.profile
  const rec = fit.recommendation
  const live = server?.live || {}
  const canApplyDirectly = server && ['mac_app', 'managed'].includes(server.mode)

  return (
    <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-900">Hardware &amp; performance</h4>
        <button onClick={() => load(true)} className="text-xs text-indigo-600 hover:underline">Re-detect</button>
      </div>

      {/* Detected hardware */}
      <div className="text-sm text-gray-700 space-y-1">
        <div><span className="font-medium">{KIND_LABEL[p.kind] || p.kind}</span>{p.chip ? ` — ${p.chip}` : ''}{p.gpu_name && p.gpu_name !== p.chip ? ` (${p.gpu_name})` : ''}</div>
        <div className="text-xs text-gray-600">
          {p.total_ram_gb} GB {p.unified_memory ? 'unified memory shared by CPU and GPU' : 'RAM'}
          {p.gpu_budget_gb != null && <> · <strong>≈{p.gpu_budget_gb} GB usable by the GPU</strong> ({p.budget_source})</>}
        </div>
        {p.notes?.map((n, i) => <div key={i} className="text-xs text-gray-500">{n}</div>)}
      </div>

      {/* Loaded models */}
      {hw.residency && hw.residency.length > 0 && (
        <div className="text-xs">
          <div className="font-medium text-gray-700 mb-1">Loaded in Ollama now</div>
          {hw.residency.map(r => (
            <div key={r.name} className={r.gpu_fraction != null && r.gpu_fraction < 0.999 ? 'text-red-700' : 'text-gray-700'}>
              {r.name}: {r.size_gb} GB, {Math.round((r.gpu_fraction || 0) * 100)}% on GPU
              {r.gpu_fraction != null && r.gpu_fraction < 0.999 && ' — partly running on CPU (slow)'}
              {r.context_length ? ` · context ${r.context_length.toLocaleString()}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* Fit table */}
      <div>
        <div className="text-xs font-medium text-gray-700">
          Installed models at your context window ({fit.num_ctx.toLocaleString()} tokens)
        </div>
        <table className="w-full text-xs mt-1">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1">Model</th><th>Weights</th><th>Context memory</th><th>Total</th><th>Fit</th>
            </tr>
          </thead>
          <tbody>
            {fit.models.map(m => (
              <tr key={m.model} className="border-b border-gray-100">
                <td className="py-1 font-mono">{m.model}{m.model === rec.active_model || m.model === `${rec.active_model}:latest` ? ' (active)' : ''}</td>
                <td>{m.weights_gb} GB</td>
                <td>{m.kv_cache_gb != null ? `${m.kv_cache_gb} GB` : '?'}</td>
                <td>≈{m.total_gb} GB</td>
                <td><span className={`px-1.5 py-0.5 rounded ${STATUS_STYLE[m.status]}`}>{STATUS_LABEL[m.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-gray-400 mt-1">Conservative estimates (weights + context memory + overhead). "Loaded in Ollama now" above is the ground truth.</p>
      </div>

      {/* Recommendations */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-gray-700">Recommended Ollama server settings for {rec.active_model}</div>
        <ul className="text-xs text-gray-600 list-disc pl-5 space-y-0.5">
          {rec.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        <div className="bg-white border border-gray-200 rounded p-2">
          <div className="text-xs font-medium text-gray-800">Reproducible (default — one request at a time)</div>
          <SettingsTable settings={rec.reproducible.settings} live={server?.known ? live : null} />
          <button
            onClick={() => setConfirm({ profileName: 'reproducible', settings: rec.reproducible.settings })}
            disabled={applying}
            className="mt-2 px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
          >
            {canApplyDirectly ? 'Apply these settings…' : 'Show how to apply…'}
          </button>
        </div>
        {rec.throughput && (
          <div className="bg-white border border-amber-200 rounded p-2">
            <div className="text-xs font-medium text-gray-800">Throughput (for opt-in parallel alignment / optimization)</div>
            <p className="text-[11px] text-amber-800">
              Lets Ollama batch {rec.throughput.settings.OLLAMA_NUM_PARALLEL} requests at once (≈{rec.throughput.estimate?.total_gb} GB).
              Batched requests can change results slightly, so QUAILS still runs analyses one at a time unless you turn parallelism on.
            </p>
            <SettingsTable settings={rec.throughput.settings} live={server?.known ? live : null} />
            <button
              onClick={() => setConfirm({ profileName: 'throughput', settings: rec.throughput.settings })}
              disabled={applying}
              className="mt-2 px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-500 disabled:opacity-50"
            >
              {canApplyDirectly ? 'Apply throughput settings…' : 'Show how to apply…'}
            </button>
          </div>
        )}
        <p className="text-[11px] text-gray-500">{rec.note}</p>
        {rec.advisories?.map((a, i) => (
          <div key={i} className="text-xs bg-amber-50 border border-amber-200 rounded p-2 text-amber-900">
            {a.message}
            <pre className="mt-1 bg-white border border-amber-200 rounded px-2 py-1 font-mono select-all">{a.command}</pre>
          </div>
        ))}
        {applying && <p className="text-xs text-gray-600">Restarting Ollama with the new settings…</p>}
        {applyResult && (
          <div className={`text-xs rounded p-2 ${applyResult.error ? 'bg-red-50 text-red-700' : applyResult.applied ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
            {applyResult.error || applyResult.message}
            {applyResult.instructions?.steps?.length > 0 && (
              <ol className="list-decimal pl-5 mt-1 space-y-1">
                {applyResult.instructions.steps.map((st, i) => <li key={i}><pre className="whitespace-pre-wrap font-mono select-all">{st}</pre></li>)}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* Benchmark */}
      <div className="flex items-center gap-3">
        <button onClick={handleBenchmark} disabled={benching} className="px-3 py-1 text-xs bg-gray-200 text-gray-800 rounded hover:bg-gray-300 disabled:opacity-50">
          {benching ? 'Running…' : `Quick benchmark (${rec.active_model})`}
        </button>
        {bench && !bench.error && (
          <span className="text-xs text-gray-700">
            load {bench.load_sec}s · prompt {bench.prompt_tokens_per_sec} tok/s · generation {bench.gen_tokens_per_sec} tok/s
          </span>
        )}
        {bench?.error && <span className="text-xs text-red-600">{bench.error}</span>}
      </div>

      {confirm && (
        <ConfirmDialog
          title="Restart Ollama with new settings?"
          message={
            (canApplyDirectly
              ? `QUAILS will set ${Object.entries(confirm.settings).map(([k, v]) => `${k}=${v}`).join(', ')} and restart Ollama. Any model loaded in Ollama will be unloaded. `
              : 'QUAILS cannot restart this Ollama installation itself; it will show you the exact commands to run. ')
            + 'Server settings change the arithmetic models use, so settle them before a study begins and keep them fixed — they are recorded with every run.'
          }
          onConfirm={handleApply}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
