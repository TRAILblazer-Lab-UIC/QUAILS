export const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
export const pp = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`)
export const ci = (c) => (!c || c[0] == null ? '' : `[${(c[0] * 100).toFixed(0)}–${(c[1] * 100).toFixed(0)}]`)

// "gemma3:latest" -> "gemma", "qwen3.6:14b" -> "qwen", "llama3.1" -> "llama"
export function modelFamily(name) {
  return (name || '').split(':')[0].split('/').pop().replace(/[\d.]+.*$/, '').replace(/[-_]$/, '').toLowerCase()
}

export const STATE_STYLES = {
  IMPROVING: 'bg-emerald-100 text-emerald-800',
  'AT-RATER-CEILING': 'bg-indigo-100 text-indigo-800',
  REGRESSING: 'bg-red-100 text-red-700',
  PLATEAU: 'bg-gray-100 text-gray-600',
  'NOT-SIGNIFICANT': 'bg-gray-100 text-gray-600',
  'INSUFFICIENT-DATA': 'bg-amber-100 text-amber-800',
  OVERFITTING: 'bg-red-100 text-red-700',
}

export const STATE_HELP = {
  IMPROVING: 'Gain over its parent is statistically reliable (95% CI excludes 0) and larger than run-to-run noise.',
  'AT-RATER-CEILING': 'Agreement reached your own consistency when re-coding — further gains would be fitting noise in the human codes.',
  REGRESSING: 'Reliably worse than its parent.',
  PLATEAU: 'Second round in a row without a reliable improvement — the search stops here.',
  'NOT-SIGNIFICANT': 'Difference from its parent is within what chance / run-to-run variation could produce.',
  'INSUFFICIENT-DATA': 'Too few cases to estimate a difference.',
}

// Word-level diff (LCS) for showing what a candidate changed.
export function wordDiff(a, b) {
  const x = (a || '').split(/(\s+)/), y = (b || '').split(/(\s+)/)
  const n = x.length, m = y.length
  if (n * m > 400000) return [{ type: 'same', text: b }]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  const push = (type, text) => {
    if (out.length && out[out.length - 1].type === type) out[out.length - 1].text += text
    else out.push({ type, text })
  }
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', x[i]); i++ }
    else { push('add', y[j]); j++ }
  }
  while (i < n) push('del', x[i++])
  while (j < m) push('add', y[j++])
  return out
}

export function promptFields(blockType, prompts) {
  if (blockType === 'sourceAnalysis') {
    return [
      { key: 'detection_prompt', label: 'Detection prompt', value: prompts?.detection_prompt || '' },
      { key: 'label_prompt', label: 'Label prompt', value: prompts?.label_prompt || '' },
    ]
  }
  return (prompts?.rubric_items || []).map((it, i) => ({
    key: `rubric_${i + 1}`, label: `Rubric ${i + 1}: ${it.title || '(untitled)'} — scoring prompt`, value: it.scoring_prompt || '',
  }))
}
