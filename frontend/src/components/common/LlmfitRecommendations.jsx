import { useState, useEffect, useCallback } from 'react'
import { getLlmfitStatus, runLlmfitScan, pullOllamaModel, installLlmfit } from '../../api'
import socket from '../../socket'

const SCORE_META = {
  fit: {
    label: 'Fit',
    color: 'bg-green-500',
    dotColor: 'bg-green-500',
    tooltip: 'How well this model fits your hardware — based on available RAM and VRAM. Higher means it will run comfortably without swapping or running out of memory.',
  },
  speed: {
    label: 'Speed',
    color: 'bg-blue-500',
    dotColor: 'bg-blue-500',
    tooltip: 'Estimated generation speed (tokens per second). Higher means faster responses. Depends on your CPU, GPU, and how much of the model fits in VRAM.',
  },
  quality: {
    label: 'Quality',
    color: 'bg-purple-500',
    dotColor: 'bg-purple-500',
    tooltip: 'Overall model capability — reasoning, instruction following, and output quality. Based on public benchmarks. Larger models generally score higher.',
  },
  context: {
    label: 'Context',
    color: 'bg-gray-400',
    dotColor: 'bg-gray-400',
    tooltip: 'How much text the model can process at once (its context window). Higher means it can handle longer documents or conversations in a single request.',
  },
}

const SCORE_KEYS = ['fit', 'speed', 'quality', 'context']

function formatParams(val) {
  if (!val) return null
  const str = String(val).trim()
  // Match number + optional unit suffix (B, M, K, etc.)
  const match = str.match(/^([\d.]+)\s*([A-Za-z]*)$/)
  if (match) {
    const num = parseFloat(match[1])
    const unit = match[2].toUpperCase() || 'B'
    if (isNaN(num)) return `${str} parameters`
    return `${num.toFixed(2)}${unit} parameters`
  }
  return `${str} parameters`
}

function formatSize(val) {
  if (val == null) return null
  const num = typeof val === 'number' ? val : parseFloat(val)
  return isNaN(num) ? val : `${num.toFixed(2)} GB`
}

function ScoreBar({ label, value, color, tooltip }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 text-gray-500 text-right cursor-help" title={tooltip}>{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className="w-8 text-gray-500 text-right">{Math.round(value)}</span>
    </div>
  )
}

export default function LlmfitRecommendations({ onModelInstalled }) {
  // idle | checking | installing | scanning | results | error
  const [state, setState] = useState('idle')
  const [installStatus, setInstallStatus] = useState('')
  const [versionInfo, setVersionInfo] = useState(null)
  const [system, setSystem] = useState(null)
  const [models, setModels] = useState([])
  const [showAll, setShowAll] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState(null)
  const [pulling, setPulling] = useState({}) // { ollamaName: { pct, status, error } }
  const [expanded, setExpanded] = useState({}) // { ollamaName: true/false }

  // SocketIO listeners
  useEffect(() => {
    function onProgress(data) {
      setPulling(prev => ({
        ...prev,
        [data.model]: { pct: data.pct, status: data.status, error: null },
      }))
    }

    function onComplete(data) {
      setPulling(prev => {
        const next = { ...prev }
        delete next[data.model]
        return next
      })
      setModels(prev => prev.map(m =>
        m.ollama_name === data.model ? { ...m, already_installed: true } : m
      ))
      if (onModelInstalled) onModelInstalled()
    }

    function onError(data) {
      setPulling(prev => ({
        ...prev,
        [data.model]: { pct: 0, status: 'error', error: data.error },
      }))
    }

    function onInstallProgress(data) {
      setInstallStatus(data.status || '')
    }

    socket.on('model_pull_progress', onProgress)
    socket.on('model_pull_complete', onComplete)
    socket.on('model_pull_error', onError)
    socket.on('llmfit_install_progress', onInstallProgress)

    return () => {
      socket.off('model_pull_progress', onProgress)
      socket.off('model_pull_complete', onComplete)
      socket.off('model_pull_error', onError)
      socket.off('llmfit_install_progress', onInstallProgress)
    }
  }, [onModelInstalled])

  const doScan = useCallback(async (vInfo) => {
    setState('scanning')

    try {
      const scanRes = await runLlmfitScan()
      const scan = scanRes.data

      if (scan.error) {
        setError(scan.error)
        setState('error')
        return
      }

      setVersionInfo(vInfo)
      setSystem(scan.system)
      setModels(scan.models || [])
      setState('results')
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Scan failed'
      setError(msg)
      setState('error')
    }
  }, [])

  const handleScan = useCallback(async () => {
    setState('checking')
    setError(null)

    try {
      const statusRes = await getLlmfitStatus()
      const status = statusRes.data

      if (!status.installed) {
        // Auto-install llmfit from GitHub releases
        setState('installing')
        setInstallStatus('Starting download...')

        try {
          const installRes = await installLlmfit()
          const result = installRes.data

          if (result.error) {
            setError(`Failed to install llmfit: ${result.error}`)
            setState('error')
            return
          }

          // Installed successfully — proceed to scan
          await doScan({ installed: true, version: result.version })
        } catch (installErr) {
          const msg = installErr.response?.data?.error || installErr.message || 'Install failed'
          setError(`Failed to install llmfit: ${msg}`)
          setState('error')
        }
        return
      }

      // Already installed — go straight to scan
      await doScan(status)
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to check status'
      setError(msg)
      setState('error')
    }
  }, [doScan])

  const handlePull = useCallback(async (ollamaName) => {
    setPulling(prev => ({
      ...prev,
      [ollamaName]: { pct: 0, status: 'starting', error: null },
    }))

    try {
      await pullOllamaModel(ollamaName)
    } catch (err) {
      setPulling(prev => ({
        ...prev,
        [ollamaName]: { pct: 0, status: 'error', error: err.message },
      }))
    }
  }, [])

  const displayModels = showAll ? models : models.slice(0, 5)

  // --- Idle state: single button ---
  if (state === 'idle') {
    return (
      <div className="mt-4">
        <button
          onClick={handleScan}
          className="w-full px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-700 hover:bg-indigo-100 transition-colors text-sm font-medium"
        >
          Test my system and recommend an LLM that fits
        </button>
      </div>
    )
  }

  // --- Checking / Installing / Scanning ---
  if (state === 'checking' || state === 'installing' || state === 'scanning') {
    const messages = {
      checking: 'Checking for llmfit...',
      installing: installStatus || 'Installing llmfit...',
      scanning: 'Analyzing your hardware...',
    }
    return (
      <div className="mt-4 flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="w-5 h-5 rounded-full border-2 border-gray-300 border-t-indigo-600 animate-spin flex-shrink-0" />
        <span className="text-sm text-gray-600">{messages[state]}</span>
      </div>
    )
  }

  // --- Error ---
  if (state === 'error') {
    return (
      <div className="mt-4 p-4 bg-red-50 border border-red-300 rounded-lg">
        <p className="text-red-800 text-sm font-medium mb-1">Something went wrong</p>
        <p className="text-red-700 text-xs">{error}</p>
        <button
          onClick={() => setState('idle')}
          className="mt-2 text-xs text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    )
  }

  // --- Results ---
  return (
    <div className="mt-4 space-y-3">
      {/* Action bar: Re-test + Collapse */}
      <div className="flex gap-2">
        <button
          onClick={handleScan}
          className="flex-1 px-4 py-2.5 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-700 hover:bg-indigo-100 transition-colors text-sm font-medium"
        >
          Re-test my system
        </button>
        <button
          onClick={() => setCollapsed(prev => !prev)}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            collapsed
              ? 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              : 'bg-red-50 border border-red-200 text-red-700 hover:bg-red-100'
          }`}
        >
          {collapsed ? 'Show results' : 'Hide results'}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* System info bar */}
          {system && Object.keys(system).length > 0 && (
            <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
              {system.cpu_name && <span><strong>CPU:</strong> {system.cpu_name}{system.cpu_cores ? ` (${system.cpu_cores} cores)` : ''}</span>}
              {system.total_ram_gb && <span><strong>RAM:</strong> {system.total_ram_gb} GB{system.available_ram_gb ? ` (${system.available_ram_gb} GB available)` : ''}</span>}
              {system.gpu_name && <span><strong>GPU:</strong> {system.gpu_name}</span>}
              {system.gpu_vram_gb != null && <span><strong>VRAM:</strong> {system.gpu_vram_gb} GB</span>}
              {system.backend && <span><strong>Backend:</strong> {system.backend}</span>}
            </div>
          )}

          {/* Legend */}
          {displayModels.length > 0 && (
            <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-xs text-gray-500 mb-2 font-medium" title="Each model is scored from 0–100 on four dimensions. Hover over a label for details.">Score legend (hover for details)</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {SCORE_KEYS.map((key) => {
                  const meta = SCORE_META[key]
                  return (
                    <span key={key} className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-help" title={meta.tooltip}>
                      <span className={`inline-block w-2.5 h-2.5 rounded-full ${meta.dotColor}`} />
                      {meta.label}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Results header */}
          {displayModels.length > 0 && (
            <div className="px-4 py-3 bg-indigo-600 rounded-lg text-white text-sm font-medium text-center">
              Top recommended LLM models for QUAILS based on your system
            </div>
          )}

          {/* Encouragement note */}
          {displayModels.length > 0 && (
            <p className="text-xs text-gray-500 leading-relaxed">
              Different models produce different results. Try downloading several and comparing
              their output — especially during alignment testing, where switching models can
              reveal which one best fits your analysis needs.
            </p>
          )}

          {/* Model table */}
          {displayModels.length === 0 ? (
            <p className="text-gray-500 text-sm">No Ollama-compatible models found in scan results.</p>
          ) : (
            <div className="space-y-2">
              {displayModels.map((model, index) => {
                const pullState = pulling[model.ollama_name]
                const isPulling = pullState && pullState.status !== 'error'
                const pullError = pullState?.error
                const rank = index + 1

                return (
                  <div
                    key={model.ollama_name}
                    className="p-3 bg-white border border-gray-200 rounded-lg"
                  >
                    <div className="flex items-start justify-between gap-3">
                      {/* Rank number */}
                      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold mt-0.5">
                        {rank}
                      </div>
                      {/* Model info + scores */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-medium text-gray-900 text-sm">{model.ollama_name}</span>
                          {formatParams(model.parameters) && (
                            <span className="text-xs text-gray-400">{formatParams(model.parameters)}</span>
                          )}
                          {formatSize(model.size_gb) && (
                            <span className="text-xs text-gray-400">{formatSize(model.size_gb)}</span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {SCORE_KEYS.map((key) => {
                            const meta = SCORE_META[key]
                            return (
                              <ScoreBar
                                key={key}
                                label={meta.label}
                                value={model.scores[key] || 0}
                                color={meta.color}
                                tooltip={meta.tooltip}
                              />
                            )
                          })}
                        </div>
                      </div>

                      {/* Action button */}
                      <div className="flex-shrink-0 pt-1">
                        {model.already_installed ? (
                          <span className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded text-xs font-medium">
                            Installed
                          </span>
                        ) : isPulling ? (
                          <div className="w-28">
                            <div className="text-xs text-gray-500 mb-1 text-center">
                              {pullState.status === 'starting' ? 'Starting...' : `${Math.round(pullState.pct)}%`}
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                              <div
                                className="h-full bg-indigo-500 rounded-full transition-all"
                                style={{ width: `${pullState.pct}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => handlePull(model.ollama_name)}
                            className="px-3 py-1.5 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-500 transition-colors"
                          >
                            Download
                          </button>
                        )}
                        {pullError && (
                          <p className="text-red-500 text-xs mt-1 max-w-[8rem]">{pullError}</p>
                        )}
                      </div>
                    </div>

                    {/* More info toggle */}
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [model.ollama_name]: !prev[model.ollama_name] }))}
                      className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      {expanded[model.ollama_name] ? 'Hide details' : 'More info'}
                    </button>

                    {/* Detail panel */}
                    {expanded[model.ollama_name] && (
                      <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 text-xs text-gray-600 space-y-2">
                        {model.use_case && (
                          <p><strong>Use case:</strong> {model.use_case}</p>
                        )}
                        {model.category && (
                          <p><strong>Category:</strong> {model.category}</p>
                        )}
                        {model.provider && (
                          <p><strong>Provider:</strong> {model.provider}</p>
                        )}
                        {model.name && (
                          <p><strong>Full model name:</strong> {model.name}</p>
                        )}
                        {model.release_date && (
                          <p><strong>Release date:</strong> {model.release_date}</p>
                        )}
                        {model.fit_level && (
                          <p><strong>Fit level:</strong> {model.fit_level}</p>
                        )}
                        {model.run_mode && (
                          <p><strong>Run mode:</strong> {model.run_mode}{model.is_moe ? ' (Mixture of Experts)' : ''}</p>
                        )}
                        {model.runtime_label && (
                          <p><strong>Runtime:</strong> {model.runtime_label}</p>
                        )}
                        {model.best_quant && (
                          <p><strong>Recommended quantization:</strong> {model.best_quant}</p>
                        )}
                        {model.estimated_tps != null && (
                          <p><strong>Estimated speed:</strong> {model.estimated_tps} tokens/sec</p>
                        )}
                        {model.context_window != null && (
                          <p><strong>Context window:</strong> {Number(model.context_window).toLocaleString()} tokens</p>
                        )}
                        {model.total_memory_gb != null && (
                          <p><strong>Total memory needed:</strong> {model.total_memory_gb} GB</p>
                        )}
                        {model.utilization_pct != null && (
                          <p><strong>VRAM utilization:</strong> {model.utilization_pct}%</p>
                        )}
                        {model.notes && model.notes.length > 0 && (
                          <div>
                            <strong>Notes:</strong>
                            <ul className="list-disc list-inside mt-1 space-y-0.5 text-gray-500">
                              {model.notes.map((note, i) => (
                                <li key={i}>{note}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Show more / less */}
          {models.length > 5 && (
            <button
              onClick={() => setShowAll(prev => !prev)}
              className="text-sm text-indigo-600 hover:text-indigo-800 underline"
            >
              {showAll ? `Show fewer` : `Show more (${models.length} total)`}
            </button>
          )}

          {/* Bottom hide button */}
          <button
            onClick={() => setCollapsed(true)}
            className="w-full px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 hover:bg-red-100 transition-colors text-sm font-medium"
          >
            Hide results
          </button>
        </>
      )}
    </div>
  )
}
