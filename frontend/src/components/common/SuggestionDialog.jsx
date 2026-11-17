import { useState, useEffect } from 'react'
import { getFeedbackConfig, submitSuggestion } from '../../api'

const CATEGORIES = ['Bug', 'Feature Request', 'General', 'Other']

export default function SuggestionDialog({ open, onClose }) {
  const [message, setMessage] = useState('')
  const [category, setCategory] = useState('General')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)

  // Reset form state when dialog opens
  useEffect(() => {
    if (open) {
      setMessage('')
      setCategory('General')
      setEmail('')
      setSending(false)
      setSent(false)
      setError(null)
    }
  }, [open])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!message.trim()) return

    setSending(true)
    setError(null)

    try {
      await submitSuggestion({
        category,
        message: message.trim(),
        email: email.trim() || undefined,
      })
      setSent(true)
    } catch (err) {
      setError('Failed to send suggestion. Please try again later.')
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Submit Suggestion</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {sent ? (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">&#10003;</div>
            <p className="text-sm font-medium text-emerald-700">Thank you! Your suggestion has been sent.</p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:border-indigo-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Message */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                required
                placeholder="Describe your suggestion, bug report, or feedback..."
                className="w-full px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:border-indigo-500 resize-vertical"
              />
            </div>

            {/* Optional email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email <span className="text-gray-400 font-normal">(optional — only if you want a response)</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {error && <p className="text-red-600 text-sm">{error}</p>}

            <p className="text-[11px] text-gray-400 leading-relaxed">
              This message is sent anonymously. No project data is included.
            </p>

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending || !message.trim()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
