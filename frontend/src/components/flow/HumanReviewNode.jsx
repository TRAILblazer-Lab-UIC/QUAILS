import { Handle, Position } from '@xyflow/react'

export default function HumanReviewNode({ data }) {
  const upstreamNum = data.upstream_block_id
    ? data.upstream_block_id.split('_').pop()
    : '—'

  const isComplete = data.status && data.status.toLowerCase().includes('complete')

  return (
    <div className="px-3 py-2.5 text-center min-w-[130px]">
      <div className="text-rose-700 text-xs font-bold leading-tight">Human Review</div>
      <div className="text-rose-500 text-[11px] mt-0.5 leading-tight">for Block ID {upstreamNum}</div>
      <div className={`flex items-center justify-center gap-1 mt-1.5 text-[11px] font-medium ${isComplete ? 'text-emerald-600' : 'text-amber-600'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${isComplete ? 'bg-emerald-500' : 'bg-amber-400'}`} />
        {isComplete ? 'Complete' : 'Pending'}
      </div>
      <Handle type="target" position={Position.Left} className="!bg-amber-500 !w-2.5 !h-2.5" />
    </div>
  )
}
