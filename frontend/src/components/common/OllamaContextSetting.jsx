import { useState, useEffect, useCallback } from 'react'
import { getOllamaContext, setOllamaContext, getHardwareFit } from '../../api'

const OLLAMA_DEFAULT = 2048
const MIN_CTX = 2048
const MAX_CTX = 131072

// Slider steps: non-linear scale for practical values
const STEPS = [
  2048, 4096, 8192, 16384, 24000, 32768, 49152, 65536, 98304, 131072,
]

function closestStep(value) {
  let best = STEPS[0]
  let bestDist = Math.abs(value - best)
  for (const s of STEPS) {
    const d = Math.abs(value - s)
    if (d < bestDist) {
      best = s
      bestDist = d
    }
  }
  return best
}

function stepIndex(value) {
  const target = closestStep(value)
  const idx = STEPS.indexOf(target)
  return idx >= 0 ? idx : 0
}

// Live memory read-out for the active model at the chosen context (unified-memory aware).
function ContextMemoryLine({ numCtx }) {
  const [fit, setFit] = useState(null)
  useEffect(() => {
    let cancelled = false
    getHardwareFit({ num_ctx: numCtx }).then(res => {
      if (cancelled) return
      const rec = res.data.recommendation
      const est = res.data.models.find(m => m.model === rec.active_model || m.model === `${rec.active_model}:latest`)
      setFit(est ? { ...est, budget: res.data.budget_gb } : null)
    }).catch(() => setFit(null))
    return () => { cancelled = true }
  }, [numCtx])
  if (!fit) return null
  const color = fit.status === 'fits' ? 'text-emerald-700' : fit.status === 'tight' ? 'text-amber-700' : fit.status === 'spills' ? 'text-red-700' : 'text-gray-600'
  return (
    <p className={`text-xs ${color}`}>
      {fit.model} at this context needs ≈{fit.total_gb} GB
      {fit.budget != null ? ` of ≈${fit.budget} GB GPU-usable memory` : ' (no GPU detected — runs on CPU)'}
      {fit.status === 'tight' && ' — tight; close other apps or lower the context.'}
      {fit.status === 'spills' && ' — will not fit; part of the model runs on the CPU (much slower). Lower the context or pick a smaller model.'}
      {fit.status === 'fits' && ' — fits.'}
      {' '}<span className="text-gray-400">(conservative estimate)</span>
    </p>
  )
}

export default function OllamaContextSetting() {
  const [current, setCurrent] = useState(null) // null = Ollama default
  const [inputValue, setInputValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showTokenHelp, setShowTokenHelp] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getOllamaContext().then(res => {
      const val = res.data.current
      setCurrent(val)
      setInputValue(val ? String(val) : '')
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const handleSave = useCallback(async (value) => {
    setSaving(true)
    try {
      const numCtx = value ? parseInt(value, 10) : 0
      const res = await setOllamaContext(numCtx > 0 ? numCtx : null)
      setCurrent(res.data.current)
      setInputValue(res.data.current ? String(res.data.current) : '')
    } catch (err) {
      console.error('Failed to save context setting:', err)
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSliderChange = useCallback((e) => {
    const idx = parseInt(e.target.value, 10)
    const val = STEPS[idx]
    setInputValue(String(val))
    handleSave(val)
  }, [handleSave])

  const handleInputBlur = useCallback(() => {
    const parsed = parseInt(inputValue, 10)
    if (!inputValue || isNaN(parsed) || parsed < MIN_CTX) {
      // Reset to default
      handleSave(null)
    } else {
      const clamped = Math.min(parsed, MAX_CTX)
      handleSave(clamped)
    }
  }, [inputValue, handleSave])

  const handleReset = useCallback(() => {
    handleSave(null)
  }, [handleSave])

  if (!loaded) return null

  const displayValue = current || OLLAMA_DEFAULT
  const isDefault = !current
  const isDefaultValue = displayValue === OLLAMA_DEFAULT

  return (
    <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-gray-900">Primary Context Window</h4>
          <button
            onClick={() => setShowHelp(prev => !prev)}
            className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 hover:bg-gray-300 text-xs font-bold flex items-center justify-center transition-colors"
            title="What is the context window?"
          >
            ?
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {isDefault ? (
              <>Ollama default: <span className="font-mono">{OLLAMA_DEFAULT.toLocaleString()}</span> tokens</>
            ) : (
              <>Override: <span className="font-mono font-medium text-indigo-700">{displayValue.toLocaleString()}</span> tokens</>
            )}
          </span>
          {!isDefault && (
            <button
              onClick={handleReset}
              className="text-xs text-red-600 hover:text-red-800 underline"
              disabled={saving}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Help text */}
      {showHelp && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900 space-y-2">
          <p>
            <strong>What is the context window?</strong> The context window is the maximum
            amount of text (measured in tokens) that the AI model can read and process in a
            single request. This includes both your input text and the model's response.
          </p>
          <p>
            <strong>Why increase it?</strong> Ollama defaults to {OLLAMA_DEFAULT.toLocaleString()} tokens,
            which is very small. If your text units are longer than this limit, the model
            will silently truncate them, leading to incomplete analysis. A larger context
            window lets the model see more of your data at once, producing more accurate results.
          </p>
          <p>
            <strong>Trade-off:</strong> Larger context windows use more RAM and VRAM, and
            can slow down generation speed. If you set the context window too high for your
            hardware, the model may run very slowly or fail to load entirely.
          </p>
          <p>
            <strong>Recommendations for QUAILS:</strong>
          </p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>
              <strong>Sentence-level analysis:</strong> 24,000 tokens is a good balance
              between accuracy and speed for most systems.
            </li>
            <li>
              <strong>Document-level analysis:</strong> 65,536 tokens or more, so the
              model can process entire documents at once. Requires a system with
              sufficient RAM/VRAM.
            </li>
            <li>
              <strong>Very long documents:</strong> 131,072 tokens, but this requires
              a specialized computer with substantial memory.
            </li>
          </ul>
        </div>
      )}

      {/* Warning banner when at default */}
      {isDefaultValue && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-100 border border-amber-400 rounded-lg">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white flex items-center justify-center text-xs font-bold">!</span>
          <span className="text-xs text-amber-800 font-medium">
            Your system is currently set to the Ollama default ({OLLAMA_DEFAULT.toLocaleString()} tokens) — this is very low for most analysis tasks.
          </span>
        </div>
      )}

      {/* Annotations above slider */}
      <div className="relative h-5 pointer-events-none">
        {/* Recommended minimum marker */}
        {(() => {
          const recIdx = STEPS.indexOf(24000)
          const pct = (recIdx / (STEPS.length - 1)) * 100
          return (
            <span
              className="absolute flex flex-col items-center whitespace-nowrap"
              style={{ left: `${pct}%`, transform: 'translateX(-50%)', bottom: 0 }}
            >
              <span className="text-emerald-600 font-medium" style={{ fontSize: '9px' }}>Recommended minimum</span>
              <span className="text-emerald-500 leading-none" style={{ fontSize: '10px', marginTop: '-2px' }}>&#9660;</span>
            </span>
          )
        })()}
      </div>

      {/* Slider with tick marks */}
      <div className="space-y-1">
        <div className="relative">
          <input
            type="range"
            min={0}
            max={STEPS.length - 1}
            step={1}
            value={stepIndex(inputValue ? parseInt(inputValue, 10) : displayValue)}
            onChange={handleSliderChange}
            disabled={saving}
            className="w-full accent-indigo-600"
          />
          {/* Tick marks below slider */}
          <div className="absolute left-0 right-0 top-full pointer-events-none" style={{ marginTop: '2px' }}>
            {STEPS.map((step, idx) => {
              const pct = (idx / (STEPS.length - 1)) * 100
              const isRecommended = step === 24000
              const isDefaultStep = step === OLLAMA_DEFAULT
              return (
                <div
                  key={step}
                  className="absolute"
                  style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}
                >
                  <div className={`w-0.5 ${isRecommended ? 'h-3 bg-emerald-500' : isDefaultStep ? 'h-3 bg-amber-400' : 'h-2 bg-gray-300'}`} />
                </div>
              )
            })}
          </div>
        </div>
        {/* Bottom labels */}
        <div className="flex justify-between text-xs text-gray-400 px-0.5 mt-4">
          <span>{STEPS[0].toLocaleString()}</span>
          <span>{STEPS[Math.floor(STEPS.length / 2)].toLocaleString()}</span>
          <span>{STEPS[STEPS.length - 1].toLocaleString()}</span>
        </div>
      </div>

      {/* Text input + "What is a token?" */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="number"
          min={MIN_CTX}
          max={MAX_CTX}
          step={1024}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
          placeholder={String(OLLAMA_DEFAULT)}
          disabled={saving}
          className="w-32 px-3 py-1.5 bg-white border border-gray-300 rounded text-gray-900 text-sm font-mono focus:outline-none focus:border-indigo-500"
        />
        <span className="text-xs text-gray-500">tokens</span>
        <button
          onClick={() => setShowTokenHelp(prev => !prev)}
          className="ml-1 px-2.5 py-1 bg-indigo-100 border border-indigo-300 rounded-full text-indigo-700 hover:bg-indigo-200 transition-colors text-xs font-medium"
        >
          {showTokenHelp ? 'Hide' : 'What is a token?'}
        </button>
        {saving && <span className="text-xs text-gray-400 ml-2">Saving...</span>}
      </div>

      {/* Token explainer */}
      {showTokenHelp && (
        <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-900 space-y-2">
          <p>
            <strong>What is a token?</strong> When an AI model reads your text, it doesn't
            read whole words the way a person does. Instead, it breaks your text into small
            pieces called "tokens." You can think of a token as a fragment of a word.
          </p>
          <p>
            <strong>How big is a token?</strong> As a rough rule of thumb, <strong>one
            token is about three-quarters of a word</strong>. So 100 words is roughly
            130 tokens, and 1,000 words is roughly 1,300 tokens. Short, common words like
            "the" or "is" are usually one token each. Longer or less common words get split
            into two or more tokens — for example, "understanding" might become three tokens.
          </p>
          <p>
            <strong>Some everyday comparisons:</strong>
          </p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>A text message or tweet — about 30–60 tokens</li>
            <li>A paragraph of writing — about 100–200 tokens</li>
            <li>One page of a book — about 300–400 tokens</li>
            <li>A 5-page essay or report — about 1,500–2,000 tokens</li>
            <li>A full 20-page research paper — about 8,000–10,000 tokens</li>
          </ul>
          <p>
            <strong>Why does this matter here?</strong> The number you set above is the
            maximum amount of text (measured in tokens) that the AI can look at in one go.
            If your text is longer than this limit, the AI will only see part of it and
            may miss important information. Setting a higher number lets the AI read more
            of your text at once, but uses more of your computer's memory.
          </p>
        </div>
      )}
      <ContextMemoryLine numCtx={displayValue} />
    </div>
  )
}
