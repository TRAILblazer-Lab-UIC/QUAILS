import { useEffect, useRef } from 'react'
import ProgressBar from './ProgressBar'

export default function ConsolePanel({ logs = [], progress = null, onClear, onClose }) {
  const logsEndRef = useRef(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  function levelColor(level) {
    switch (level) {
      case 'error': return 'text-red-400'
      case 'warn': return 'text-amber-400'
      case 'info': return 'text-slate-300'
      default: return 'text-slate-400'
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Descriptive header */}
      <div className="px-4 py-2 border-b border-gray-700 bg-blue-950 flex items-start justify-between gap-4">
        <p className="text-blue-200 text-xs leading-relaxed">
          <span className="font-semibold text-white">Live Analysis Activity</span>
          {' '}— While an analysis is running, this area shows you a real-time record of what the AI is doing: which items it has processed, what decisions it made, and whether anything went wrong. When the analysis finishes, the record stays here so you can scroll back and review it. It does not affect your results — it is purely for your reference.
        </p>
        <button
          onClick={onClose}
          className="shrink-0 px-3 py-1 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded transition-colors"
          title="Close activity log"
        >
          Close
        </button>
      </div>
      {progress && (
        <div className="px-4 py-2 border-b border-gray-700">
          <ProgressBar
            current={progress.current}
            total={progress.total}
            pct={progress.pct}
            blockId={progress.block_id}
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {logs.length === 0 && (
          <p className="text-slate-600 italic">No activity yet. Start an analysis on a block to see live updates here.</p>
        )}
        {logs.map((log, i) => (
          <div key={i} className={`py-0.5 ${levelColor(log.level)}`}>
            <span className="text-slate-600 mr-2">[{log.timestamp}]</span>
            {log.message}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
      <div className="px-3 py-1 border-t border-gray-700 flex justify-between">
        <span className="text-slate-500 text-xs">{logs.length} messages</span>
        <button
          onClick={onClear}
          className="text-slate-500 text-xs hover:text-slate-300"
        >
          Clear
        </button>
      </div>
    </div>
  )
}
