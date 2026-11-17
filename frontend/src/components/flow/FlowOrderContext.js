import { createContext, useContext } from 'react'

// Maps nodeId -> sequence number (1-based) based on topological sort of the flow graph.
// Nodes not reachable from any root (disconnected) will have no entry (undefined).
export const FlowOrderContext = createContext({})

export function useFlowOrder() {
  return useContext(FlowOrderContext)
}
