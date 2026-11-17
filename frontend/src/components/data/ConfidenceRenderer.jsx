export default function ConfidenceRenderer(props) {
  const value = parseFloat(props.value)
  if (isNaN(value)) return <span>{props.value}</span>

  let className = 'confidence-cell '
  if (value >= 80) className += 'confidence-high'
  else if (value >= 50) className += 'confidence-medium'
  else className += 'confidence-low'

  return <span className={className}>{value.toFixed(2)}%</span>
}
