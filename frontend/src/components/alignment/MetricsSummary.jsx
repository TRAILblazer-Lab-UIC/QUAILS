import KappaDisplay from './KappaDisplay'

export default function MetricsSummary({ metrics, blockType }) {
  if (!metrics) return null

  const overall = metrics.overall_score ?? 0
  const detection = metrics.detection
  const labels = metrics.labels
  const rubric = metrics.rubric_scores
  const themeMatch = metrics.theme_match
  const singleOutput = metrics.single_output

  function scoreColor(score) {
    if (score >= 80) return 'text-emerald-700'
    if (score >= 60) return 'text-green-700'
    if (score >= 40) return 'text-amber-700'
    return 'text-red-600'
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-gray-900 font-medium text-sm mb-3">Metrics Summary</h4>

      <div className="flex flex-wrap gap-6 mb-4">
        {/* Overall score */}
        <div className="text-center">
          <div className={`text-3xl font-bold ${scoreColor(overall)}`}>
            {overall.toFixed(1)}%
          </div>
          <div className="text-gray-500 text-xs mt-1">Overall Score</div>
        </div>

        {/* Detection metrics */}
        {detection && detection.n > 0 && (
          <div className="text-center">
            <div className={`text-2xl font-bold ${scoreColor(detection.percent_alignment)}`}>
              {detection.percent_alignment}%
            </div>
            <div className="text-gray-500 text-xs mt-1">Detection Agreement</div>
            <div className="text-gray-400 text-[10px]">
              kappa = {detection.cohens_kappa} ({detection.interpretation})
            </div>
          </div>
        )}

        {/* Label similarity */}
        {labels && labels.mean_similarity > 0 && (
          <div className="text-center">
            <div className={`text-2xl font-bold ${scoreColor(labels.mean_similarity)}`}>
              {labels.mean_similarity}%
            </div>
            <div className="text-gray-500 text-xs mt-1">Label Similarity</div>
          </div>
        )}

        {/* Rubric scores */}
        {rubric && Object.keys(rubric).map(key => {
          const r = rubric[key]
          return (
            <div key={key} className="text-center">
              <div className={`text-2xl font-bold ${scoreColor(r.percent_alignment)}`}>
                {r.percent_alignment}%
              </div>
              <div className="text-gray-500 text-xs mt-1">{r.title}</div>
              <div className="text-gray-400 text-[10px]">
                kappa = {r.cohens_kappa} | weighted = {r.weighted_kappa}
              </div>
            </div>
          )
        })}

        {/* Theme match agreement (themeIdent, v1) */}
        {themeMatch && themeMatch.n > 0 && (
          <div className="text-center">
            <div className={`text-2xl font-bold ${scoreColor(themeMatch.percent_alignment)}`}>
              {themeMatch.percent_alignment}%
            </div>
            <div className="text-gray-500 text-xs mt-1">Theme Match Agreement</div>
          </div>
        )}

        {/* Single-output similarity (categoryBuild/customPrompt, v1) */}
        {singleOutput && singleOutput.similarity != null && (
          <div className="text-center">
            <div className={`text-2xl font-bold ${scoreColor(singleOutput.similarity)}`}>
              {singleOutput.similarity.toFixed(1)}%
            </div>
            <div className="text-gray-500 text-xs mt-1">Output Similarity</div>
          </div>
        )}
      </div>
    </div>
  )
}
