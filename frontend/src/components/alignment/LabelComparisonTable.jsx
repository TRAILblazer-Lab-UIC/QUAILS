export default function LabelComparisonTable({ labelMetrics, humanLabels, llmResults }) {
  if (!labelMetrics?.per_unit) return null

  const entries = Object.entries(labelMetrics.per_unit).sort(([a], [b]) => a.localeCompare(b))

  function simColor(sim) {
    if (sim >= 80) return 'text-emerald-700'
    if (sim >= 60) return 'text-green-700'
    if (sim >= 40) return 'text-amber-700'
    return 'text-red-600'
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-gray-900 font-medium text-sm mb-3">Label Comparison</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-3 text-gray-500 text-xs font-medium">Unit ID</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">Human Labels</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">LLM Labels</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">Similarity</th>
              <th className="py-2 pl-3 text-gray-500 text-xs font-medium">LLM Rationale</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([unitId, data]) => {
              const hLabels = humanLabels?.[unitId]?.labels || []
              const lLabels = llmResults?.[unitId]?.labels || []
              const reasoning = llmResults?.[unitId]?.reasoning || ''
              const sim = data.unit_similarity ?? 0

              return (
                <tr key={unitId} className="border-b border-gray-100">
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-gray-500">{unitId}</td>
                  <td className="py-1.5 px-3 text-gray-900">{hLabels.join(', ') || '—'}</td>
                  <td className="py-1.5 px-3 text-gray-900">{lLabels.join(', ') || '—'}</td>
                  <td className={`py-1.5 px-3 font-medium ${simColor(sim)}`}>
                    {sim.toFixed(1)}%
                  </td>
                  <td className="py-1.5 pl-3 text-gray-500 text-xs max-w-xs truncate" title={reasoning}>
                    {reasoning || '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pairings detail */}
      {entries.some(([, d]) => d.pairings?.length > 0) && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 cursor-pointer">Show label pairings detail</summary>
          <div className="mt-2 space-y-2">
            {entries.map(([unitId, data]) => {
              if (!data.pairings?.length && !data.unmatched_human?.length && !data.unmatched_llm?.length) return null
              return (
                <div key={unitId} className="text-xs bg-gray-50 rounded p-2">
                  <span className="font-mono text-gray-400">{unitId}:</span>
                  {data.pairings?.map((p, i) => (
                    <span key={i} className="ml-2 text-gray-600">
                      "{p.human}" ~ "{p.llm}" ({p.similarity.toFixed(1)}%)
                    </span>
                  ))}
                  {data.unmatched_human?.length > 0 && (
                    <span className="ml-2 text-red-500">unmatched human: {data.unmatched_human.join(', ')}</span>
                  )}
                  {data.unmatched_llm?.length > 0 && (
                    <span className="ml-2 text-amber-600">unmatched LLM: {data.unmatched_llm.join(', ')}</span>
                  )}
                </div>
              )
            })}
          </div>
        </details>
      )}
    </div>
  )
}
