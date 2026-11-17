import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAboutPage } from '../../api'
import SuggestionDialog from './SuggestionDialog'

let _cachedVersion = null

export default function AppFooter({ onNavigate, compact = false }) {
  const navigate = useNavigate()
  const [version, setVersion] = useState(_cachedVersion)
  const [showSuggestion, setShowSuggestion] = useState(false)

  useEffect(() => {
    if (_cachedVersion) return
    getAboutPage()
      .then(res => {
        const v = res.data?.metadata?.version
        if (v) { _cachedVersion = v; setVersion(v) }
      })
      .catch(() => {})
  }, [])

  function go(path) {
    if (onNavigate) onNavigate(path)
    else navigate(path)
  }

  const suggestionBtn = (
    <button
      onClick={() => setShowSuggestion(true)}
      className="hover:text-gray-600 hover:underline underline-offset-2 transition-colors"
    >
      Submit Suggestion
    </button>
  )

  if (compact) {
    return (
      <>
        <div className="px-4 py-3 border-t border-gray-100 text-[11px] text-gray-400 space-y-1">
          <p className="font-medium leading-tight">QUAILS: Qualitative AI Labeling Support</p>
          {version && <p>Version {version}</p>}
          <div className="flex gap-3 pt-0.5">
            <button
              onClick={() => go('/about')}
              className="hover:text-gray-600 hover:underline underline-offset-2 transition-colors"
            >
              About the app
            </button>
            {suggestionBtn}
            <button
              onClick={() => go('/settings')}
              className="hover:text-gray-600 hover:underline underline-offset-2 transition-colors"
            >
              AI Settings
            </button>
          </div>
        </div>
        <SuggestionDialog open={showSuggestion} onClose={() => setShowSuggestion(false)} />
      </>
    )
  }

  return (
    <>
      <div className="mt-10 pt-5 border-t border-gray-200 text-xs text-gray-400 space-y-1 text-center">
        <p className="font-medium">QUAILS: Qualitative AI Labeling Support</p>
        {version && <p>Version {version}</p>}
        <div className="flex gap-4 pt-0.5 justify-center">
          <button
            onClick={() => go('/about')}
            className="hover:text-gray-600 hover:underline underline-offset-2 transition-colors"
          >
            About the app
          </button>
          {suggestionBtn}
          <button
            onClick={() => go('/settings')}
            className="hover:text-gray-600 hover:underline underline-offset-2 transition-colors"
          >
            AI Settings
          </button>
        </div>
      </div>
      <SuggestionDialog open={showSuggestion} onClose={() => setShowSuggestion(false)} />
    </>
  )
}
