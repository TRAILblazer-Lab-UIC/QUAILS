import { Handle, Position } from '@xyflow/react'
import { useReviewStatus } from './FlowOrderContext'

const STATUS_STYLE = {
  approved: { text: 'Approved', cls: 'text-emerald-600', dot: 'bg-emerald-500' },
  pending:  { text: 'Needs review', cls: 'text-amber-600', dot: 'bg-amber-400' },
  outdated: { text: 'Re-review needed', cls: 'text-red-600', dot: 'bg-red-500' },
  waiting:  { text: 'Waiting for block', cls: 'text-gray-500', dot: 'bg-gray-300' },
}

export default function HumanReviewNode({ id, data }) {
  const reviews = useReviewStatus()
  const upstreamNum = data.upstream_block_id
    ? data.upstream_block_id.split('_').pop()
    : '—'
  const st = STATUS_STYLE[reviews[id]?.status] || STATUS_STYLE.waiting

  return (
    <div className="px-3 py-2.5 text-center min-w-[130px]">
      <div className="text-rose-700 text-xs font-bold leading-tight">Human Review</div>
      <div className="text-rose-500 text-[11px] mt-0.5 leading-tight">for Block ID {upstreamNum}</div>
      <div className={`flex items-center justify-center gap-1 mt-1.5 text-[11px] font-medium ${st.cls}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
        {st.text}
      </div>
      <Handle type="target" position={Position.Left} className="!bg-amber-500 !w-2.5 !h-2.5" />
    </div>
  )
}
