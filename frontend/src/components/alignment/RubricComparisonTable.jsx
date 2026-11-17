export default function RubricComparisonTable({ rubricMetrics, humanLabels, llmResults, rubricItems }) {
  if (!rubricMetrics || Object.keys(rubricMetrics).length === 0) return null

  // Build per-unit rows
  const unitIds = Object.keys(humanLabels || {}).sort()

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-gray-900 font-medium text-sm mb-3">Rubric Score Comparison</h4>

      {/* Per-rubric summary */}
      <div className="flex flex-wrap gap-4 mb-4">
        {Object.entries(rubricMetrics).map(([key, r]) => (
          <div key={key} className="bg-gray-50 rounded p-2 text-center min-w-[120px]">
            <div className="text-xs text-gray-500 mb-1">{r.title}</div>
            <div className="text-sm font-medium text-gray-900">
              Exact: {r.percent_alignment}% (k={r.cohens_kappa})
            </div>
            <div className="text-xs text-gray-600">
              Weighted: {r.weighted_percent}% (k={r.weighted_kappa})
            </div>
            <div className="text-[10px] text-gray-400">{r.interpretation}</div>
          </div>
        ))}
      </div>

      {/* Per-unit detail table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-3 text-gray-500 text-xs font-medium">Unit ID</th>
              {(rubricItems || []).map((item, idx) => (
                <th key={idx} className="py-2 px-2 text-gray-500 text-xs font-medium" colSpan={2}>
                  {item.title || `Rubric ${idx + 1}`}
                </th>
              ))}
            </tr>
            <tr className="border-b border-gray-100 text-left">
              <th className="py-1 pr-3 text-gray-400 text-[10px]"></th>
              {(rubricItems || []).map((_, idx) => (
                <th key={idx} className="py-1 px-1 text-gray-400 text-[10px]" colSpan={1}>
                  Human / LLM
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {unitIds.map(unitId => {
              const hScores = humanLabels[unitId]?.rubric_scores || {}
              const lScores = llmResults?.[unitId]?.rubric_scores || {}

              return (
                <tr key={unitId} className="border-b border-gray-100">
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-gray-500">{unitId}</td>
                  {(rubricItems || []).map((_, idx) => {
                    const key = `rubric_${idx + 1}`
                    const h = hScores[key]
                    const l = lScores[key]
                    const match = h != null && l != null && String(h) === String(l)
                    return (
                      <td
                        key={idx}
                        className={`py-1.5 px-2 text-xs ${match ? 'bg-emerald-50 text-emerald-800' : h != null && l != null ? 'bg-red-50 text-red-800' : 'text-gray-600'}`}
                      >
                        {h ?? '—'} / {l ?? '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
