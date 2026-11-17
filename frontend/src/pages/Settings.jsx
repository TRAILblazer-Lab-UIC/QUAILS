import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AppFooter from '../components/common/AppFooter'
import LlmfitRecommendations from '../components/common/LlmfitRecommendations'
import OllamaContextSetting from '../components/common/OllamaContextSetting'
import HardwarePerformanceCard from '../components/common/HardwarePerformanceCard'
import {
  getProviders,
  saveProviderKey,
  deleteProviderKey,
  getProviderModels,
  setActiveModel,
  getSettingsHealth,
} from '../api'

const PROVIDER_ORDER = ['ollama', 'openai', 'anthropic', 'google', 'azure']

export default function Settings() {
  const [providers, setProviders] = useState([])
  const [activeProvider, setActiveProvider] = useState('ollama')
  const [activeModelName, setActiveModelName] = useState('gemma3')
  const [health, setHealth] = useState(null)
  const [keys, setKeys] = useState({})       // { providerId: { key: '', extra: '' } }
  const [models, setModels] = useState({})   // { providerId: ['model1', ...] }
  const [selected, setSelected] = useState({}) // { providerId: 'model-name' }
  const [loading, setLoading] = useState({}) // { providerId: true/false }
  const [errors, setErrors] = useState({})   // { providerId: 'error msg' }
  const [pageLoading, setPageLoading] = useState(true)
  const [activeFlash, setActiveFlash] = useState(false)
  const [activatedModel, setActivatedModel] = useState(null) // { provider, model } for confirmation
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([loadProviders(), loadHealth()]).finally(() => setPageLoading(false))
  }, [])

  async function loadProviders() {
    try {
      const res = await getProviders()
      const data = res.data
      setProviders(data.providers)
      setActiveProvider(data.active_provider)
      setActiveModelName(data.active_model)
      // Initialize selected model per provider from active
      setSelected(prev => ({
        ...prev,
        [data.active_provider]: data.active_model,
      }))
    } catch (err) {
      console.error('Failed to load providers:', err)
    }
  }

  async function loadHealth() {
    try {
      const res = await getSettingsHealth()
      setHealth(res.data)
    } catch (err) {
      setHealth({ connected: false, error: 'Failed to check health' })
    }
  }

  async function handleSaveKey(providerId) {
    const keyData = keys[providerId] || {}
    if (!keyData.key) return

    setLoading(prev => ({ ...prev, [providerId]: true }))
    setErrors(prev => ({ ...prev, [providerId]: null }))
    try {
      const res = await saveProviderKey(providerId, {
        key: keyData.key,
        extra: keyData.extra || '',
      })
      // Clear the key input after save
      setKeys(prev => ({ ...prev, [providerId]: { key: '', extra: '' } }))
      // Reload providers to get updated status
      await loadProviders()
      await loadHealth()
      if (res.data.error) {
        setErrors(prev => ({ ...prev, [providerId]: res.data.error }))
      }
    } catch (err) {
      setErrors(prev => ({ ...prev, [providerId]: 'Failed to save key' }))
    } finally {
      setLoading(prev => ({ ...prev, [providerId]: false }))
    }
  }

  async function handleDeleteKey(providerId) {
    setLoading(prev => ({ ...prev, [providerId]: true }))
    try {
      await deleteProviderKey(providerId)
      setModels(prev => ({ ...prev, [providerId]: [] }))
      await loadProviders()
      await loadHealth()
    } catch (err) {
      setErrors(prev => ({ ...prev, [providerId]: 'Failed to delete key' }))
    } finally {
      setLoading(prev => ({ ...prev, [providerId]: false }))
    }
  }

  async function handleLoadModels(providerId) {
    setLoading(prev => ({ ...prev, [`models_${providerId}`]: true }))
    setErrors(prev => ({ ...prev, [providerId]: null }))
    try {
      const res = await getProviderModels(providerId)
      if (res.data.error) {
        setErrors(prev => ({ ...prev, [providerId]: res.data.error }))
        setModels(prev => ({ ...prev, [providerId]: [] }))
      } else {
        setModels(prev => ({ ...prev, [providerId]: res.data.models }))
      }
    } catch (err) {
      setErrors(prev => ({ ...prev, [providerId]: 'Failed to load models' }))
    } finally {
      setLoading(prev => ({ ...prev, [`models_${providerId}`]: false }))
    }
  }

  async function handleSetActive(providerId) {
    const model = selected[providerId]
    if (!model) return

    try {
      await setActiveModel(providerId, model)
      setActiveProvider(providerId)
      setActiveModelName(model)
      setActiveFlash(true)
      setActivatedModel({ provider: providerId, model })
      setTimeout(() => { setActiveFlash(false); setActivatedModel(null) }, 4000)
      await loadHealth()
    } catch (err) {
      setErrors(prev => ({ ...prev, [providerId]: 'Failed to set active model' }))
    }
  }

  function getKeyInput(providerId) {
    return keys[providerId] || { key: '', extra: '' }
  }

  function setKeyInput(providerId, field, value) {
    setKeys(prev => ({
      ...prev,
      [providerId]: { ...(prev[providerId] || { key: '', extra: '' }), [field]: value },
    }))
  }

  // Sort providers in defined order
  const sortedProviders = [...providers].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a.id) - PROVIDER_ORDER.indexOf(b.id)
  )

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        {/* Back button */}
        <div className="mb-6 flex justify-center">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium px-5 py-2.5 rounded-lg shadow-sm transition-colors text-sm"
          >
            <span>&larr; Back to Projects</span>
          </button>
        </div>

        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <img src="/logo.png" alt="Logo for the QUAILS system" className="h-12" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">AI Model Settings</h1>
            <p className="text-gray-600 text-sm">Manage LLM providers and API keys</p>
          </div>
        </div>

        {/* Health Banner */}
        {health && (
          <div className={`mb-6 p-4 rounded-lg border ${
            health.connected
              ? 'bg-green-50 border-green-300'
              : 'bg-red-50 border-red-300'
          }`}>
            <div className="flex items-center gap-2">
              <span className={`inline-block w-3 h-3 rounded-full ${
                health.connected ? 'bg-green-500' : 'bg-red-500'
              }`} />
              <span className="text-gray-900 font-medium">
                {health.connected
                  ? `Connected: ${health.provider} / ${health.model}`
                  : `Disconnected: ${health.error || 'Unknown error'}`
                }
              </span>
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {pageLoading && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-10 h-10 rounded-full border-4 border-gray-200 border-t-indigo-600 animate-spin" />
            <p className="text-sm text-gray-500">Loading settings...</p>
          </div>
        )}

        {/* Privacy Notice */}
        {!pageLoading && <div className="mb-6 p-4 bg-amber-50 border border-amber-300 rounded-lg">
          <p className="text-amber-800 text-sm font-medium mb-1">Data Privacy Notice</p>
          <p className="text-amber-700 text-xs leading-relaxed">
            <strong>No data is ever sent to the app developer</strong> — this application
            runs entirely on your own computer and has no connection to its developers.
            Anonymized crash reports and user suggestions are only sent to the developer
            with your explicit permission each time. No other data is transferred to the
            developer at any time.{' '}
            <strong>Ollama (Local):</strong> No data leaves your machine and no internet connection
            is required for AI analysis once you have downloaded an LLM model to run the AI on your own computer.{' '}
            <strong>Cloud providers:</strong> Your document text is sent to that provider's servers
            for processing. Be aware of research ethics, IRB requirements, and legal regulations
            (HIPAA, FERPA, GDPR) regarding personally identifiable information or confidential data.
            You are solely liable for any third-party data sharing that occurs through this application.
          </p>
        </div>}

        {/* AI Provider explainer */}
        {!pageLoading && <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900 space-y-2">
          <p>
            <strong>What is a third-party AI provider?</strong>{' '}
            Companies like OpenAI, Anthropic, Google, and Microsoft offer powerful AI models
            that run on their servers in the cloud. To use them, you send your text to their
            servers over the internet and receive a response. This requires an internet connection
            and you will typically be charged per use.
            This is different from Ollama, which runs an AI model entirely on your own computer
            with no internet required.
          </p>
          <p>
            <strong>What is an API key?</strong>{' '}
            An API key is a private password that identifies you to a cloud AI provider.
            You create one on the provider's website, then paste it here. Keep it secret —
            anyone who has it can use your account and incur charges on your behalf.
          </p>
          <p>
            For setup instructions, see the{' '}
            <a
              href="/api/about/readme"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 hover:text-blue-700"
            >
              README.txt
            </a>.
          </p>
        </div>}

        {/* How QUAILS reasons — expandable explainer */}
        {!pageLoading && (
          <div className="mb-6 border border-slate-200 rounded-lg bg-white overflow-hidden">
            <button
              onClick={() => setReasoningOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors group"
            >
              <div className="flex items-center gap-2.5">
                {/* lightbulb icon */}
                <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.355a7.5 7.5 0 0 1-3 0M12 3v.75m0 0a9 9 0 1 0 0 16.5A9 9 0 0 0 12 3Z" />
                </svg>
                <span className="text-sm font-semibold text-slate-700 group-hover:text-indigo-700 transition-colors">
                  About how QUAILS does its reasoning compared to other AI systems
                </span>
              </div>
              <svg
                className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform duration-200 ${reasoningOpen ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            {reasoningOpen && (
              <div className="px-5 pb-5 pt-1 border-t border-slate-100 space-y-4 text-sm text-slate-700 leading-relaxed">

                <p className="text-slate-500 text-xs italic pt-1">
                  If you've used AI tools before, you may wonder why QUAILS behaves differently from chatbots. Here's what's happening under the hood.
                </p>

                <div>
                  <p className="font-semibold text-slate-800 mb-1">What is "thinking mode" in AI?</p>
                  <p>
                    Some AI chatbots — such as ChatGPT's reasoning models, DeepSeek, or Gemini — are designed to
                    "think out loud" before answering. You can see this as a collapsible block of internal reasoning
                    that appears before the final response. This helps the AI work through open-ended or multi-step
                    problems, like solving a math puzzle or writing a strategy document.
                  </p>
                </div>

                <div>
                  <p className="font-semibold text-slate-800 mb-1">QUAILS turns this off — and here's why</p>
                  <p className="mb-2">
                    QUAILS is not having a conversation. It is running the same analytical task across hundreds or
                    thousands of text units and needs to be consistent, measurable, and tied strictly to your prompts.
                    Free-form thinking by the AI works against all three of those goals.
                  </p>
                  <ul className="space-y-2 pl-1">
                    <li className="flex gap-2">
                      <span className="text-indigo-400 font-bold flex-shrink-0">·</span>
                      <span>
                        <strong>Confidence scores would become unreliable.</strong> QUAILS measures how certain the
                        AI was about each decision by examining the probability of the first tokens it generated —
                        a technique called <em>logprob scoring</em>. When thinking mode is active, the AI's first
                        tokens are reasoning thoughts, not the answer. Those tokens dilute the probability signal
                        and make confidence scores meaningless.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-indigo-400 font-bold flex-shrink-0">·</span>
                      <span>
                        <strong>Responses must follow your instructions, not the model's internal intuitions.</strong>{' '}
                        Each unit is analyzed using only the prompts you write. If the AI reasons freely before
                        responding, it can drift from your coding criteria and introduce inconsistency across units —
                        undermining the systematic nature of the analysis.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-indigo-400 font-bold flex-shrink-0">·</span>
                      <span>
                        <strong>Replicability requires determinism.</strong> Thinking tokens are generated
                        unpredictably each time. QUAILS is designed to produce the same result when run on the same
                        data with the same settings — a requirement for rigorous qualitative research.
                      </span>
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="font-semibold text-slate-800 mb-1">How QUAILS does its own reasoning</p>
                  <p>
                    Rather than letting the AI think freely, QUAILS asks for reasoning as a structured follow-up
                    question <em>after</em> each classification or scoring decision. This keeps justifications
                    short, on-topic, and grounded in the specific coding criteria you set — and records them
                    alongside the label and confidence score in the output file so you can audit every decision.
                  </p>
                </div>

                <p className="text-xs text-slate-400 border-t border-slate-100 pt-3">
                  In short: thinking mode trades systematic reliability for open-ended flexibility. QUAILS makes
                  the opposite trade — the one that qualitative research requires.
                </p>

              </div>
            )}
          </div>
        )}

        {/* Provider Cards */}
        {!pageLoading &&
        <div className="space-y-4">
          {sortedProviders.map((provider) => {

            const isActive = provider.id === activeProvider
            const providerModels = models[provider.id] || []
            const isLoadingModels = loading[`models_${provider.id}`]
            const isLoadingKey = loading[provider.id]
            const error = errors[provider.id]
            const keyInput = getKeyInput(provider.id)

            return (
              <div
                key={provider.id}
                className={`p-5 bg-white rounded-lg border transition-colors ${
                  isActive ? 'border-indigo-500 ring-1 ring-indigo-500/50' : 'border-gray-200'
                }`}
              >
                {/* Provider Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-gray-900 font-medium text-lg">{provider.name}</h3>
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                      provider.connected ? 'bg-green-500' : 'bg-gray-300'
                    }`} title={provider.connected ? 'Connected' : 'Not connected'} />
                    {isActive && (
                      <span className="inline-flex items-center gap-1.5 text-xs bg-indigo-600 text-white px-2 py-0.5 rounded">
                        <svg className="w-3.5 h-3.5 text-green-300" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 4.5 8.25v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                        </svg>
                        Active: <span className="font-mono">{activeModelName}</span>
                      </span>
                    )}
                  </div>
                  {provider.has_key && (
                    <span className="text-gray-500 text-sm font-mono">{provider.masked_key}</span>
                  )}
                </div>

                {/* API Key Input (hidden for Ollama) */}
                {provider.requires_key && (
                  <div className="mb-3 space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder="API Key"
                        value={keyInput.key}
                        onChange={(e) => setKeyInput(provider.id, 'key', e.target.value)}
                        className="flex-1 px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500 text-sm"
                      />
                      <button
                        onClick={() => handleSaveKey(provider.id)}
                        disabled={!keyInput.key || isLoadingKey}
                        className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                      >
                        {isLoadingKey ? 'Saving...' : 'Save Key'}
                      </button>
                      {provider.has_key && (
                        <button
                          onClick={() => handleDeleteKey(provider.id)}
                          disabled={isLoadingKey}
                          className="px-4 py-2 bg-red-600/80 text-white rounded hover:bg-red-500 disabled:opacity-50 text-sm transition-colors"
                        >
                          Delete
                        </button>
                      )}
                    </div>

                    {/* Azure extra field */}
                    {provider.extra_field && (
                      <input
                        type="text"
                        placeholder="Azure Endpoint URL"
                        value={keyInput.extra}
                        onChange={(e) => setKeyInput(provider.id, 'extra', e.target.value)}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500 text-sm"
                      />
                    )}
                    {provider.has_extra && provider.masked_extra && (
                      <p className="text-gray-500 text-xs">Endpoint: {provider.masked_extra}</p>
                    )}
                  </div>
                )}

                {/* Error message */}
                {error && (
                  <p className="text-red-600 text-sm mb-3">{error}</p>
                )}

                {/* Ollama instruction header */}
                {provider.id === 'ollama' && (
                  <div className="mb-2">
                    <h4 className="text-sm font-medium text-gray-900">Select the LLM model to use:</h4>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Ollama is a background app that helps your computer talk to an LLM (i.e., the AI) and the QUAILS app. Click the button below to see which LLM models you have installed in Ollama, then choose one and set it as active. The internet is only needed to download an LLM model to your computer to analyze data. None of your data is being transferred to any AI provider during this process. If you don't have any LLM models yet, use the "system test" further down to find and download an LLM that fits your computer well. Your system specifications will be tested on your own computer and a list of highest-matching models will be suggested to you.
                    </p>
                  </div>
                )}

                {/* Model Selection */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleLoadModels(provider.id)}
                    disabled={isLoadingModels || (provider.requires_key && !provider.has_key)}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
                  >
                    {isLoadingModels ? 'Loading...' : 'Load my installed models'}
                  </button>

                  {providerModels.length > 0 && (
                    <>
                      <select
                        value={selected[provider.id] || ''}
                        onChange={(e) => setSelected(prev => ({ ...prev, [provider.id]: e.target.value }))}
                        className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">Select a model...</option>
                        {providerModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>

                      <button
                        onClick={() => handleSetActive(provider.id)}
                        disabled={!selected[provider.id]}
                        className="px-4 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                      >
                        Set as Active
                      </button>
                    </>
                  )}
                </div>

                {/* Activation confirmation */}
                {activatedModel && activatedModel.provider === provider.id && (
                  <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-300 rounded-lg">
                    <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                    </svg>
                    <span className="text-green-800 text-sm font-medium">
                      <span className="font-mono">{activatedModel.model}</span> is now your active model
                    </span>
                  </div>
                )}

                {/* Ollama-specific settings */}
                {provider.id === 'ollama' && (
                  <>
                    <OllamaContextSetting />
                    <HardwarePerformanceCard />
                    <LlmfitRecommendations onModelInstalled={() => handleLoadModels('ollama')} />
                  </>
                )}

              </div>
            )
          })}
        </div>}

        <div className="mt-6 flex justify-center">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium px-5 py-2.5 rounded-lg shadow-sm transition-colors text-sm"
          >
            <span>&larr; Back to Projects</span>
          </button>
        </div>
        <AppFooter />
      </div>
    </div>
  )
}
