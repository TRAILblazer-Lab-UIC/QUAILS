import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary.jsx'
import './styles/global.css'
import './styles/flow.css'
import './styles/grid.css'

// Catch unhandled JS errors outside of React's tree
window.onerror = (message, source, lineno, colno, error) => {
  try {
    const existing = localStorage.getItem('quails_crash')
    if (!existing) {
      localStorage.setItem('quails_crash', JSON.stringify({
        type: 'crash_report',
        timestamp: new Date().toISOString(),
        platform: navigator.platform,
        browser: navigator.userAgent,
        error_message: message || 'Unknown error',
        error_stack: error?.stack || `${source}:${lineno}:${colno}`,
        component_stack: '',
      }))
    }
  } catch (_) { /* storage unavailable */ }
}

// Catch unhandled promise rejections
window.onunhandledrejection = (event) => {
  try {
    const existing = localStorage.getItem('quails_crash')
    if (!existing) {
      const reason = event.reason
      localStorage.setItem('quails_crash', JSON.stringify({
        type: 'crash_report',
        timestamp: new Date().toISOString(),
        platform: navigator.platform,
        browser: navigator.userAgent,
        error_message: reason?.message || String(reason),
        error_stack: reason?.stack || '',
        component_stack: '',
      }))
    }
  } catch (_) { /* storage unavailable */ }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
