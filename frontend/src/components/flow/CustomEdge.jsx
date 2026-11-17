import { BaseEdge, getStraightPath } from '@xyflow/react'

export default function CustomEdge({ id, sourceX, sourceY, targetX, targetY, data }) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY })

  const strokeColor = data?.status === 'complete' ? '#10b981'
    : data?.status === 'running' ? '#f59e0b'
    : '#94a3b8'

  return (
    <BaseEdge id={id} path={edgePath} style={{ stroke: strokeColor, strokeWidth: 2 }} />
  )
}
