import { useState } from 'react'
import { generateAlignmentSample } from '../../api'
import HelpLabel from '../common/HelpLabel'
import ConfirmDialog from '../common/ConfirmDialog'

export default function SampleGenerator({ projectId, blockId, hasExistingSample, onSampleGenerated }) {
  const [sampleSize, setSampleSize] = useState(20)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function doGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await generateAlignmentSample(projectId, blockId, sampleSize)
      if (res.data.error) {
        setError(res.data.error)
      } else {
        onSampleGenerated(res.data)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate sample')
    } finally {
      setGenerating(false)
    }
  }

  function handleGenerateClick() {
    if (hasExistingSample) {
      setConfirmOpen(true)
    } else {
      doGenerate()
    }
  }

  function handleConfirm() {
    setConfirmOpen(false)
    doGenerate()
  }

  return (
    <div>
      {confirmOpen && (
        <ConfirmDialog
          title="Generate New Sample?"
          message="This will discard the current sample and any human labels entered for it. This cannot be undone. Continue?"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
      <div className="flex gap-3 items-end">
        <label className="block">
          <HelpLabel
            label="Sample Size"
            help="Number of random text units to draw from this block's data source for alignment testing."
          />
          <input
            type="number"
            min="1"
            max="200"
            value={sampleSize}
            onChange={(e) => setSampleSize(parseInt(e.target.value) || 20)}
            className="block mt-1 w-24 px-2 py-1.5 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
          />
        </label>
        <button
          onClick={handleGenerateClick}
          disabled={generating || !blockId}
          className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {generating ? 'Generating...' : hasExistingSample ? 'Generate New Sample' : 'Generate Sample'}
        </button>
      </div>
      {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
    </div>
  )
}
