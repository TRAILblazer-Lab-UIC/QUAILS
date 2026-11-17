import { Component } from 'react'

/**
 * React error boundary — catches render errors and shows a recovery UI
 * with an option to send an anonymous crash report via Formspree.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null, sending: false, sent: false, showDetails: false }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })

    // Persist to localStorage so App.jsx can show a recovery banner on restart
    try {
      const crashData = {
        type: 'crash_report',
        timestamp: new Date().toISOString(),
        platform: navigator.platform,
        browser: navigator.userAgent,
        error_message: error?.message || String(error),
        error_stack: error?.stack || '',
        component_stack: errorInfo?.componentStack || '',
      }
      localStorage.setItem('quails_crash', JSON.stringify(crashData))
    } catch (_) { /* storage full or unavailable */ }
  }

  async handleSendReport() {
    this.setState({ sending: true })
    try {
      // Fetch Formspree URL from backend
      const res = await fetch('/api/settings/feedback-config')
      const config = await res.json()

      if (!config.crash_report_url) {
        this.setState({ sent: true, sending: false })
        return
      }

      const payload = {
        type: 'crash_report',
        app_version: config.app_version || 'unknown',
        timestamp: new Date().toISOString(),
        platform: navigator.platform,
        browser: navigator.userAgent,
        error_message: this.state.error?.message || String(this.state.error),
        error_stack: this.state.error?.stack || '',
        component_stack: this.state.errorInfo?.componentStack || '',
      }

      await fetch(config.crash_report_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      // Clear localStorage on successful send
      localStorage.removeItem('quails_crash')
      this.setState({ sent: true, sending: false })
    } catch (_) {
      this.setState({ sent: true, sending: false })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { error, sending, sent, showDetails } = this.state

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
        <div className="max-w-lg w-full bg-white rounded-xl shadow-lg border border-gray-200 p-8 text-center space-y-5">
          <img src="/logo.png" alt="QUAILS" className="h-16 mx-auto" />
          <h1 className="text-xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="text-sm text-gray-600">
            QUAILS encountered an unexpected error. You can send an anonymous crash report
            to help the developer fix this issue, or simply reload the app.
          </p>

          {/* Collapsible error details */}
          <div>
            <button
              onClick={() => this.setState({ showDetails: !showDetails })}
              className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
            >
              {showDetails ? 'Hide' : 'Show'} error details
            </button>
            {showDetails && (
              <pre className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded text-xs text-left text-gray-700 overflow-auto max-h-40">
                {error?.message || String(error)}
                {'\n'}
                {error?.stack || ''}
              </pre>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            {!sent ? (
              <button
                onClick={() => this.handleSendReport()}
                disabled={sending}
                className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send anonymous crash report'}
              </button>
            ) : (
              <p className="text-sm text-emerald-700 font-medium">Thank you! Report sent.</p>
            )}

            {!sent && (
              <button
                onClick={() => { localStorage.removeItem('quails_crash'); this.setState({ sent: true }) }}
                className="w-full px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
              >
                No thanks
              </button>
            )}

            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reload QUAILS
            </button>
          </div>

          <p className="text-[11px] text-gray-400 leading-relaxed">
            This sends only the error message, your browser and OS type, and the app version.
            No project data, documents, or personal information is ever included.
          </p>
        </div>
      </div>
    )
  }
}
