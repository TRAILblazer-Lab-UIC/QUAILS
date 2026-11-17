import { useState, useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import ProjectList from './pages/ProjectList'
import ProjectWorkspace from './pages/ProjectWorkspace'
import Settings from './pages/Settings'
import About from './pages/About'
import { getFeedbackConfig, submitCrashReport } from './api'

function CrashRecoveryBanner() {
  const [crashData, setCrashData] = useState(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('quails_crash')
      if (raw) setCrashData(JSON.parse(raw))
    } catch (_) { /* ignore */ }
  }, [])

  function dismiss() {
    localStorage.removeItem('quails_crash')
    setCrashData(null)
  }

  async function sendReport() {
    setSending(true)
    try {
      await submitCrashReport(crashData)
    } catch (_) { /* best effort */ }
    dismiss()
  }

  if (!crashData) return null

  return (
    <div className="bg-amber-50 border-b border-amber-300 px-4 py-2.5 flex items-center justify-between text-sm">
      <span className="text-amber-800">
        QUAILS recovered from an error.
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={sendReport}
          disabled={sending}
          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium transition-colors disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send report'}
        </button>
        <button
          onClick={dismiss}
          className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <CrashRecoveryBanner />
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/about" element={<About />} />
        <Route path="/project/:projectId/*" element={<ProjectWorkspace />} />
      </Routes>
    </div>
  )
}

export default App
