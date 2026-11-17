import { Handle, Position } from '@xyflow/react'

export default function ProjectSpecNode({ id, data }) {
  return (
    <div className="px-4 py-3 min-w-[200px]">
      <div className="flex items-center justify-between mb-1">
        <div className="text-blue-100 text-xs font-semibold uppercase">Start</div>
      </div>
      <div className="text-white font-medium text-sm">{data.label || 'Project Spec'}</div>
      {data.corpusSummary && (
        <div className="text-blue-100 text-xs mt-1">{data.corpusSummary}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-white !w-3 !h-3" />
    </div>
  )
}
