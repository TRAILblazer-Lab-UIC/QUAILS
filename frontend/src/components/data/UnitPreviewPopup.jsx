import { useState, useEffect, useRef } from 'react'
import { getUnitPreview } from '../../api'

export default function UnitPreviewPopup({ projectId, unitId, onClose, onOpenInViewer }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const overlayRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getUnitPreview(projectId, unitId)
      .then(res => {
        if (!cancelled) setData(res.data)
      })
      .catch(err => {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load unit')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectId, unitId])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <span className="font-mono text-sm text-indigo-600">{unitId}</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {loading && <p className="text-gray-400 text-sm">Loading...</p>}
          {error && <p className="text-red-600 text-sm">{error}</p>}
          {data && (
            <>
              {/* Document info */}
              <div className="text-xs text-gray-500">
                {data.filename} &mdash; doc #{data.doc_index}
              </div>

              {/* Context before */}
              {data.context_before && (
                <div className="text-sm text-gray-400 italic border-l-2 border-gray-200 pl-3">
                  {data.context_before}
                </div>
              )}

              {/* Main text */}
              <div className="text-sm text-gray-900 bg-amber-50 border border-amber-200 rounded p-3">
                {data.text}
              </div>

              {/* Context after */}
              {data.context_after && (
                <div className="text-sm text-gray-400 italic border-l-2 border-gray-200 pl-3">
                  {data.context_after}
                </div>
              )}

              {/* Provenance for cell-sentence sub-units */}
              {data.unit_type === 'R' && (
                <div className="text-xs text-gray-500">
                  Sentence from column <strong className="text-gray-700">{data.column_name}</strong>
                  {data.parent_unit_id && (
                    <>
                      {' '}&middot; row unit{' '}
                      <button
                        onClick={() => onOpenInViewer(data.parent_unit_id)}
                        className="font-mono text-indigo-600 hover:underline"
                      >
                        {data.parent_unit_id}
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Row data for tabular units */}
              {data.row_data && (
                <div className="border border-gray-200 rounded overflow-hidden">
                  <div className="px-3 py-1.5 bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
                    Row Data
                  </div>
                  <div className="divide-y divide-gray-100">
                    {Object.entries(data.row_data).map(([key, value]) => (
                      <div key={key} className="flex px-3 py-1.5 text-xs">
                        <span className="text-gray-500 font-medium w-1/3 shrink-0">{key}</span>
                        <span className="text-gray-900">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => {
              onOpenInViewer(unitId)
              onClose()
            }}
            disabled={loading || !!error}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            View in Document Viewer
          </button>
        </div>
      </div>
    </div>
  )
}
