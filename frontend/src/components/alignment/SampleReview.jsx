import { useState } from 'react'

export default function SampleReview({ units, labels, onLabelsChange }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  const [currentDetection, setCurrentDetection] = useState('TRUE')

  function handleAssign() {
    if (!units[currentIndex]) return
    const newLabel = {
      unit_id: units[currentIndex].unit_id,
      label: currentDetection === 'TRUE' ? currentLabel : 'FALSE',
      detection: currentDetection,
    }
    const updated = [...labels.filter(l => l.unit_id !== newLabel.unit_id), newLabel]
    onLabelsChange(updated)
    setCurrentLabel('')
    setCurrentDetection('TRUE')
    if (currentIndex < units.length - 1) {
      setCurrentIndex(currentIndex + 1)
    }
  }

  const unit = units[currentIndex]
  const existingLabel = labels.find(l => l.unit_id === unit?.unit_id)

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
          disabled={currentIndex <= 0}
          className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded disabled:opacity-50"
        >
          Prev
        </button>
        <span className="text-gray-600 text-sm">
          Unit {currentIndex + 1} of {units.length}
        </span>
        <button
          onClick={() => setCurrentIndex(Math.min(units.length - 1, currentIndex + 1))}
          disabled={currentIndex >= units.length - 1}
          className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded disabled:opacity-50"
        >
          Next
        </button>
        <span className="text-gray-400 text-xs">
          {labels.length} / {units.length} labeled
        </span>
      </div>

      {unit && (
        <div className="bg-gray-50 rounded-lg p-4 mb-3">
          <div className="text-gray-400 font-mono text-xs mb-2">{unit.unit_id}</div>
          <div className="text-gray-900 text-sm">{unit.text}</div>
          {unit.context_before && (
            <div className="text-gray-500 text-xs mt-2 italic">Before: {unit.context_before}</div>
          )}
          {unit.context_after && (
            <div className="text-gray-500 text-xs mt-1 italic">After: {unit.context_after}</div>
          )}
        </div>
      )}

      <div className="flex gap-3 items-end">
        <label className="block">
          <span className="text-gray-600 text-xs">Detection</span>
          <select
            value={currentDetection}
            onChange={(e) => setCurrentDetection(e.target.value)}
            className="block mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
          >
            <option value="TRUE">TRUE (Relevant)</option>
            <option value="FALSE">FALSE (Not relevant)</option>
          </select>
        </label>
        {currentDetection === 'TRUE' && (
          <label className="block flex-1">
            <span className="text-gray-600 text-xs">Label</span>
            <input
              value={currentLabel}
              onChange={(e) => setCurrentLabel(e.target.value)}
              className="block mt-1 w-full px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              placeholder="Enter label/code"
            />
          </label>
        )}
        <button
          onClick={handleAssign}
          className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-500"
        >
          Assign
        </button>
      </div>

      {existingLabel && (
        <div className="mt-2 text-xs text-emerald-700">
          Labeled: {existingLabel.detection} {existingLabel.label ? `- ${existingLabel.label}` : ''}
        </div>
      )}
    </div>
  )
}
