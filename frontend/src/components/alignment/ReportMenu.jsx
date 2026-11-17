import { useEffect, useRef, useState } from 'react'
import { saveBlob } from './downloadUtil'

const FORMATS = [
  { id: 'docx', label: 'Word (.docx)' },
  { id: 'md', label: 'Markdown (.md)' },
  { id: 'txt', label: 'Plain text (.txt)' },
]

/**
 * "Report ▾" button: downloads a write-up report in the chosen format.
 * fetcher(format) must return an axios blob response.
 */
export default function ReportMenu({ fetcher, filenameBase, label = 'Download Report', className = '' }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  async function download(fmt) {
    setOpen(false)
    setBusy(true)
    try {
      const res = await fetcher(fmt)
      saveBlob(res.data, `${filenameBase}_report.${fmt}`)
    } catch (err) {
      console.error('Report download failed:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        disabled={busy}
        title="Reporting materials for a write-up: facts, tables and reporting points (no drafted prose)"
        className={className || 'px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors disabled:opacity-50'}
      >
        {busy ? 'Preparing…' : `${label} ▾`}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-40 bg-white border border-gray-200 rounded shadow-lg">
          {FORMATS.map(f => (
            <button
              key={f.id}
              onClick={(e) => { e.stopPropagation(); download(f.id) }}
              className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
