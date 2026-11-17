import { useState, useEffect } from 'react'
import { getAlignmentBlocks } from '../../api'
import HelpLabel from '../common/HelpLabel'

const TYPE_META = {
  sourceAnalysis: { label: 'Open-Coding Analysis', badge: 'bg-blue-100 text-blue-700' },
  rubricAnalysis: { label: 'Rubric-Based Analysis', badge: 'bg-purple-100 text-purple-700' },
  themeIdent: { label: 'Theme Identification', badge: 'bg-orange-100 text-orange-700' },
  categoryBuild: { label: 'Category Builder', badge: 'bg-lime-100 text-lime-700' },
  customPrompt: { label: 'Custom Prompt', badge: 'bg-teal-100 text-teal-700' },
}

// Same derivation as the canvas nodes (e.g. SourceAnalysisNode.jsx) so the ID
// shown here matches what's printed on the block in the Analysis Builder.
function blockIdSuffix(blockId) {
  return blockId.split('_').pop()
}

function optionLabel(b) {
  const typeLabel = (TYPE_META[b.block_type] || TYPE_META.sourceAnalysis).label
  const stepText = b.step_number != null ? `Step ${b.step_number}` : 'Not in pipeline'
  return `${stepText} — ${b.label} (${typeLabel}, Block ID: ${blockIdSuffix(b.block_id)})`
}

export default function BlockSelector({ projectId, isActive, selectedBlockId, onSelect }) {
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Re-fetch whenever this tab becomes active (not just on first mount) so
  // blocks added/edited in the Analysis Builder while this panel stayed
  // mounted in the background show up here.
  useEffect(() => {
    if (isActive === undefined || isActive) {
      loadBlocks()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isActive])

  async function loadBlocks() {
    setLoading(true)
    setError(null)
    try {
      const res = await getAlignmentBlocks(projectId)
      // Handle both array response and object-with-error response
      if (Array.isArray(res.data)) {
        setBlocks(res.data)
      } else if (res.data?.error) {
        setError(res.data.error)
      } else {
        setBlocks([])
      }
    } catch (err) {
      console.error('Failed to load blocks:', err)
      setError('Failed to load blocks from server. The backend may need to be restarted.')
    } finally {
      setLoading(false)
    }
  }

  function typeBadge(type) {
    const meta = TYPE_META[type] || TYPE_META.sourceAnalysis
    return <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${meta.badge}`}>{meta.label}</span>
  }

  function stepBadge(stepNumber) {
    return stepNumber != null
      ? <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Step {stepNumber}</span>
      : <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-500">–</span>
  }

  if (loading) return <div className="text-gray-400 text-sm">Loading blocks...</div>

  if (error) {
    return <div className="text-red-600 text-sm">{error}</div>
  }

  if (blocks.length === 0) {
    return (
      <div className="text-gray-500 text-sm">
        No blocks have been initialized with data yet in your Analysis Builder canvas. Add settings and link data to your analysis blocks to begin an alignment analysis.
      </div>
    )
  }

  const selectedBlock = blocks.find(b => b.block_id === selectedBlockId)

  return (
    <div>
      <HelpLabel
        label="Select Block"
        help="Each entry below is one specific block from your Analysis Builder canvas — matching its Step number and Block ID there — not a general block type. If you have two blocks of the same type (e.g. two Rubric-Based blocks), each gets its own fully independent alignment test."
      />
      <select
        value={selectedBlockId || ''}
        onChange={(e) => {
          const block = blocks.find(b => b.block_id === e.target.value)
          onSelect(block || null)
        }}
        className="mt-1 block w-full max-w-md px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-indigo-500"
      >
        <option value="">-- Select a block --</option>
        {blocks.map(b => (
          <option key={b.block_id} value={b.block_id}>
            {optionLabel(b)}
          </option>
        ))}
      </select>
      {selectedBlock && (
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
          {stepBadge(selectedBlock.step_number)}
          <span className="font-mono">Block ID: {blockIdSuffix(selectedBlock.block_id)}</span>
          {typeBadge(selectedBlock.block_type)}
        </div>
      )}
    </div>
  )
}
