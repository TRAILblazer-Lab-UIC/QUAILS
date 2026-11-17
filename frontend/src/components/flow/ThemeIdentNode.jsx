import { Handle, Position } from '@xyflow/react'
import { useFlowOrder } from './FlowOrderContext'

export default function ThemeIdentNode({ id, data }) {
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
      <div className="text-gray-900 font-medium text-sm">{data.label || 'Theme Identification'}</div>
      <div className="text-gray-500 text-xs mt-1">Constant comparison</div>
      {(data.input_block_ids?.length ?? 0) > 0 && (
        <p className="text-xs text-indigo-600 mt-0.5">{data.input_block_ids.length} source{data.input_block_ids.length > 1 ? 's' : ''}</p>
      )}
      {data.status && (
        <div className={`text-xs mt-1 ${data.status === 'complete' ? 'text-emerald-700' : 'text-amber-700'}`}>
          {data.status}
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-indigo-500 !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500 !w-3 !h-3" />
    </div>
  )
}
