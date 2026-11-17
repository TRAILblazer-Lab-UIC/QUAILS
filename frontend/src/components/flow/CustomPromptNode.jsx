import { Handle, Position } from '@xyflow/react'
import { useFlowOrder } from './FlowOrderContext'

export default function CustomPromptNode({ id, data }) {
  const sequenceOrder = useFlowOrder()
  const blockNum = id.split('_').pop()
  const seqNum = sequenceOrder[id]

  return (
    <div className="px-3 py-2 min-w-[200px]">
      <div className="flex items-center justify-between mb-1">
        <div className="text-indigo-600 text-xs font-semibold">Block ID: {blockNum}</div>
        {seqNum != null
          ? <div className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Step {seqNum}</div>
          : <div className="text-xs font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-500">–</div>
        }
      </div>
      <div className="text-gray-900 font-medium text-sm">{data.label || 'Custom Prompt'}</div>
      <div className="text-gray-500 text-xs mt-1">User-defined analysis</div>
      {data.prompt && (
        <div className="text-gray-400 text-xs mt-1 truncate max-w-[250px]">{data.prompt}</div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-indigo-500 !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500 !w-3 !h-3" />
    </div>
  )
}
