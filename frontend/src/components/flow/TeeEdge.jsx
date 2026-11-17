import { useNodes } from '@xyflow/react'

/**
 * TeeEdge — inverted-T layout:
 *   - Main vertical line from the bottom handle of the source analysis block
 *     to the top handle of the target analysis block.
 *   - A perpendicular horizontal branch from the midpoint of that vertical line
 *     to the left-side handle of the floating HumanReview block.
 *
 * sourceX/Y and targetX/Y are the actual handle positions (bottom-center and
 * top-center respectively), so no node lookup is needed for the main line.
 */
export default function TeeEdge({ sourceX, sourceY, targetX, targetY, data }) {
  const nodes = useNodes()

  const strokeColor = data?.status === 'complete' ? '#10b981'
    : data?.status === 'running' ? '#f59e0b'
    : '#94a3b8'

  // Main vertical line: bottom of source → top of target
  const mainPath = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`

  // Tap point at the midpoint of the main line
  const tapX = (sourceX + targetX) / 2
  const tapY = (sourceY + targetY) / 2

  let branchPath = null
  if (data?.humanReviewId) {
    const hrNode = nodes.find(n => n.id === data.humanReviewId)
    if (hrNode) {
      const hrH = hrNode.measured?.height ?? 56
      // Left-center handle of the HR node
      const hrHandleX = hrNode.position.x
      const hrHandleY = hrNode.position.y + hrH / 2

      // Orthogonal path: go horizontally from tap point to HR's X,
      // then vertically if the HR node isn't perfectly centred at tapY
      branchPath = `M ${tapX} ${tapY} L ${hrHandleX} ${tapY} L ${hrHandleX} ${hrHandleY}`
    }
  }

  return (
    <g>
      <path d={mainPath} stroke={strokeColor} strokeWidth={2} fill="none" />
      {branchPath && (
        <path d={branchPath} stroke={strokeColor} strokeWidth={2} fill="none" />
      )}
    </g>
  )
}
