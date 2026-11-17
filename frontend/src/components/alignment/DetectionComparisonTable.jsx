export default function DetectionComparisonTable({ details, llmResults }) {
  if (!details || Object.keys(details).length === 0) return null

  const entries = Object.entries(details).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-gray-900 font-medium text-sm mb-3">Detection Comparison</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-3 text-gray-500 text-xs font-medium">Unit ID</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">Human</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">LLM</th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">Confidence</th>
              <th className="py-2 pl-3 text-gray-500 text-xs font-medium">Aligned</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([unitId, d]) => {
              const llm = llmResults?.[unitId]
              return (
                <tr
                  key={unitId}
                  className={`border-b border-gray-100 ${d.aligned ? 'bg-emerald-50' : 'bg-red-50'}`}
                >
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-gray-500">{unitId}</td>
                  <td className="py-1.5 px-3 text-gray-900">{d.human}</td>
                  <td className="py-1.5 px-3 text-gray-900">{d.llm}</td>
                  <td className="py-1.5 px-3 text-gray-600">
                    {llm?.detection_confidence != null ? `${llm.detection_confidence}%` : '—'}
                  </td>
                  <td className={`py-1.5 pl-3 font-medium ${d.aligned ? 'text-emerald-700' : 'text-red-600'}`}>
                    {d.aligned ? 'Yes' : 'No'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
