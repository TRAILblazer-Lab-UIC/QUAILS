import { Handle, Position } from '@xyflow/react'

export default function OutputsReportNode({ id, data }) {
  return (
    <div className="px-4 py-3 min-w-[200px]">
      <div className="flex items-center justify-between mb-1">
        <div className="text-emerald-100 text-xs font-semibold uppercase">End</div>
      </div>
      <div className="text-white font-medium text-sm">{data.label || 'Outputs & Report'}</div>
      {data.reportPath && (
        <div className="text-emerald-100 text-xs mt-1">Report available</div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-white !w-3 !h-3" />
    </div>
  )
}
