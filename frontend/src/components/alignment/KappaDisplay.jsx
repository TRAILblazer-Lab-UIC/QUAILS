export default function KappaDisplay({ history }) {
  if (!history || history.length === 0) return null

  const latest = history[history.length - 1]

  function kappaColor(k) {
    if (k >= 0.81) return 'text-emerald-700'
    if (k >= 0.61) return 'text-green-700'
    if (k >= 0.41) return 'text-amber-700'
    if (k >= 0.21) return 'text-orange-600'
    return 'text-red-600'
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <div className="text-center">
          <div className={`text-3xl font-bold ${kappaColor(latest.kappa)}`}>
            {latest.kappa?.toFixed(4)}
          </div>
          <div className="text-gray-500 text-xs mt-1">Cohen's Kappa</div>
        </div>
        <div>
          <div className="text-gray-700 text-sm">{latest.interpretation}</div>
          <div className="text-gray-400 text-xs">n = {latest.n}</div>
        </div>
      </div>

      {history.length > 1 && (
        <div>
          <p className="text-gray-500 text-xs font-semibold mb-2">History</p>
          <div className="space-y-1">
            {history.map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className="text-gray-400">#{i + 1}</span>
                <span className={kappaColor(entry.kappa)}>
                  kappa = {entry.kappa?.toFixed(4)}
                </span>
                <span className="text-gray-500">{entry.interpretation}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kappa scale reference */}
      <div className="mt-4 p-3 bg-gray-50 rounded">
        <p className="text-gray-500 text-xs font-semibold mb-1">Kappa Scale Reference</p>
        <div className="grid grid-cols-2 gap-1 text-xs">
          <span className="text-red-600">&lt; 0.20: Slight</span>
          <span className="text-orange-600">0.21-0.40: Fair</span>
          <span className="text-amber-700">0.41-0.60: Moderate</span>
          <span className="text-green-700">0.61-0.80: Substantial</span>
          <span className="text-emerald-700">&gt; 0.81: Almost Perfect</span>
        </div>
      </div>
    </div>
  )
}
