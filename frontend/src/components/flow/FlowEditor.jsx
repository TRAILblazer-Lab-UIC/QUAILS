import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react'
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  Panel,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import ProjectSpecNode from './ProjectSpecNode'
import SourceAnalysisNode from './SourceAnalysisNode'
import RubricAnalysisNode from './RubricAnalysisNode'
import ThemeIdentNode from './ThemeIdentNode'
import CategoryBuildNode from './CategoryBuildNode'
import CustomPromptNode from './CustomPromptNode'
import HumanReviewNode from './HumanReviewNode'
import OutputsReportNode from './OutputsReportNode'
import NodeExpandedPanel from './NodeExpandedPanel'
import CustomEdge from './CustomEdge'
import TeeEdge from './TeeEdge'
import { FlowOrderContext, ReviewStatusContext } from './FlowOrderContext'
import { getFlow, saveFlow, validateFlow, runAnalysis, stopAnalysis, resumeAnalysis, getReviews, approveReview, revokeReview } from '../../api'
import socket from '../../socket'
import { usePromptSync } from '../../store/promptSync'

const STEP_NUMBERED_TYPES = new Set(['sourceAnalysis', 'rubricAnalysis', 'themeIdent', 'categoryBuild', 'customPrompt'])

// Step number = position of the block in blockOrder (among STEP_NUMBERED_TYPES only).
// Topology is enforced as a movement constraint in moveBlockUp/moveBlockDown, not here.
function computeSequenceOrder(nodes, edges, blockOrder = []) {
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))
  const order = {}
  let seq = 1
  for (const id of blockOrder) {
    if (STEP_NUMBERED_TYPES.has(nodeMap[id]?.type)) {
      order[id] = seq++
    }
  }
  return order
}

// BFS check: is there a directed path from `fromId` to `toId`?
function hasPath(fromId, toId, edges) {
  const visited = new Set()
  const queue = [fromId]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === toId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    edges.forEach(e => { if (e.source === cur) queue.push(e.target) })
  }
  return false
}

// Excluded from the Step Order panel (symbolic / floating nodes)
const STEP_ORDER_EXCLUDED = new Set(['humanReview', 'projectSpec', 'outputsReport'])

const STEP_TYPE_DOT = {
  projectSpec:    'bg-blue-500',
  sourceAnalysis: 'bg-violet-500',
  rubricAnalysis: 'bg-sky-500',
  themeIdent:     'bg-orange-500',
  categoryBuild:  'bg-lime-500',
  customPrompt:   'bg-teal-500',
  outputsReport:  'bg-emerald-500',
}

const nodeTypes = {
  projectSpec: ProjectSpecNode,
  sourceAnalysis: SourceAnalysisNode,
  rubricAnalysis: RubricAnalysisNode,
  themeIdent: ThemeIdentNode,
  categoryBuild: CategoryBuildNode,
  customPrompt: CustomPromptNode,
  humanReview: HumanReviewNode,
  outputsReport: OutputsReportNode,
}

const edgeTypes = {
  custom: CustomEdge,
  tee: TeeEdge,
}

const ANALYSIS_NODE_TYPES = new Set(['sourceAnalysis', 'rubricAnalysis', 'themeIdent', 'categoryBuild', 'customPrompt'])

/**
 * Walk edges backwards from nodeId, skipping humanReview nodes,
 * and return the first upstream analysis block found (or null).
 */
export function findUpstreamAnalysisBlock(nodeId, nodes, edges) {
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))
  const visited = new Set()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    // Find all edges whose target is current
    const incoming = edges.filter(e => e.target === current)
    for (const edge of incoming) {
      const src = nodeMap[edge.source]
      if (!src) continue
      if (ANALYSIS_NODE_TYPES.has(src.type)) return src
      if (src.type === 'humanReview') queue.push(src.id)
    }
  }
  return null
}

/**
 * Return all analysis blocks directly connected as sources to nodeId via tee edges.
 * Used for themeIdent nodes which accept multiple upstream analysis blocks.
 */
export function findAllUpstreamAnalysisBlocks(nodeId, nodes, edges) {
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))
  return edges
    .filter(e => e.target === nodeId)
    .map(e => nodeMap[e.source])
    .filter(n => n && ANALYSIS_NODE_TYPES.has(n.type))
}

let nodeIdCounter = 0

const FlowEditorInner = forwardRef(function FlowEditorInner({ projectId, onOpenInData }, ref) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState(null)
  const [validationErrors, setValidationErrors] = useState([])
  const [isRunning, setIsRunning] = useState(false)
  // Whole-pipeline run state: idle | running | paused | error | complete
  const [pipeline, setPipeline] = useState({ state: 'idle' })
  const [reviews, setReviews] = useState({})
  const nodesRef = useRef([])
  const [addBlockExpanded, setAddBlockExpanded] = useState(false)
  const [blockOrder, setBlockOrder] = useState([])
  const [stepOrderExpanded, setStepOrderExpanded] = useState(false)
  const [autosaveStatus, setAutosaveStatus] = useState('idle') // idle | saving | saved | error
  const reactFlowWrapper = useRef(null)
  const { screenToFlowPosition } = useReactFlow()
  // Guards against the autosave effect firing on the initial loadFlow()
  // population (a fresh project load is not a user edit).
  const skipAutosaveRef = useRef(true)
  const flowLoadedRef = useRef(false) // true once flow.json has been loaded into state

  useEffect(() => { nodesRef.current = nodes }, [nodes])

  const sequenceOrder = useMemo(() => computeSequenceOrder(nodes, edges, blockOrder), [nodes, edges, blockOrder])

  useImperativeHandle(ref, () => ({
    saveFlow: () => handleSave(),
  }))

  useEffect(() => {
    loadFlow()
  }, [projectId])

  // --- Live link with the Alignment tab (see store/promptSync.js) ---
  // Publish every analysis block's data so Alignment reads Builder edits live.
  useEffect(() => {
    const blocks = {}
    for (const n of nodes) {
      if (ANALYSIS_NODE_TYPES.has(n.type)) blocks[n.id] = n.data
    }
    usePromptSync.getState().publishBlocks(blocks)
  }, [nodes])

  // Apply edits made from the Alignment tab to the canonical node state; the
  // autosave effect below then persists them (FlowEditor stays the one writer
  // of flow.json, so nothing gets overwritten with stale data).
  const blockPatch = usePromptSync(s => s.blockPatch)
  useEffect(() => {
    if (!blockPatch.rev || !blockPatch.blockId) return
    setNodes(nds => nds.map(n =>
      n.id === blockPatch.blockId ? { ...n, data: { ...n.data, ...blockPatch.patch } } : n))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockPatch.rev])

  // Let other tabs flush pending block edits to disk (e.g. before an alignment run).
  useEffect(() => {
    usePromptSync.getState().registerFlowSaver(() =>
      flowLoadedRef.current ? saveFlow(projectId, { nodes, edges, blockOrder }) : Promise.resolve())
  }, [projectId, nodes, edges, blockOrder])

  // Debounced autosave: block settings, canvas layout, and connections were
  // previously only ever persisted by an explicit "Save Project" click —
  // anything edited in between was lost on a tab switch away from this
  // component's mounted lifetime, a page reload, or a backend restart, and
  // never reached the Alignment tab (which reads flow.json straight from
  // disk). This mirrors the same debounce pattern already used for the
  // Alignment tab's own autosave.
  useEffect(() => {
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false
      return
    }
    setAutosaveStatus('saving')
    const timer = setTimeout(async () => {
      try {
        await saveFlow(projectId, { nodes, edges, blockOrder })
        setAutosaveStatus('saved')
      } catch (err) {
        console.error('Autosave failed:', err)
        setAutosaveStatus('error')
      }
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, blockOrder])

  async function loadFlow() {
    try {
      skipAutosaveRef.current = true
      const res = await getFlow(projectId)
      const data = res.data
      let loadedNodes = data.nodes || []
      let loadedEdges = data.edges || []

      // Migrate old topology: source→humanReview→target
      // to new topology: source→target (tee) with humanReview floating
      const nodeMap = Object.fromEntries(loadedNodes.map(n => [n.id, n]))
      const hrNodes = loadedNodes.filter(n => n.type === 'humanReview')
      const edgesToRemove = new Set()
      const edgesToAdd = []
      for (const hr of hrNodes) {
        const inEdge  = loadedEdges.find(e => e.target === hr.id)
        const outEdge = loadedEdges.find(e => e.source === hr.id)
        if (inEdge && outEdge) {
          edgesToRemove.add(inEdge.id)
          edgesToRemove.add(outEdge.id)
          edgesToAdd.push({
            id: `e-${inEdge.source}-${outEdge.target}`,
            source: inEdge.source,
            target: outEdge.target,
            type: 'tee',
            data: { humanReviewId: hr.id },
          })
          // Populate upstream info on the HR node (for canvas display)
          const srcNodeMigrate = nodeMap[inEdge.source]
          if (srcNodeMigrate) {
            hr.data = {
              ...hr.data,
              upstream_block_id: srcNodeMigrate.id,
              upstream_block_type: srcNodeMigrate.type,
              upstream_block_label: srcNodeMigrate.data?.label || srcNodeMigrate.id,
            }
          }
          // Reposition the HR node to the right of the vertical midpoint
          const srcNode = nodeMap[inEdge.source]
          const tgtNode = nodeMap[outEdge.target]
          if (srcNode && tgtNode) {
            const srcW = 200  // fallback — measured not available at load time
            const srcH = 80
            const bottomCenterX = srcNode.position.x + srcW / 2
            const tapY = (srcNode.position.y + srcH + tgtNode.position.y) / 2
            hr.position = { x: bottomCenterX + 80, y: tapY - 28 }
          }
        }
      }
      if (edgesToRemove.size > 0) {
        loadedEdges = loadedEdges.filter(e => !edgesToRemove.has(e.id)).concat(edgesToAdd)
      }

      // Migrate themeIdent nodes: input_block_id (singular) → input_block_ids (array)
      const nodeMapMigrate = Object.fromEntries(loadedNodes.map(n => [n.id, n]))
      loadedNodes = loadedNodes.map(n => {
        if (n.type !== 'themeIdent') return n
        if (Array.isArray(n.data?.input_block_ids)) return n
        const fromSingular = n.data?.input_block_id ? [n.data.input_block_id] : []
        const fromEdges = loadedEdges
          .filter(e => e.target === n.id)
          .map(e => e.source)
          .filter(srcId => {
            const src = nodeMapMigrate[srcId]
            return src && ANALYSIS_NODE_TYPES.has(src.type)
          })
        const ids = [...new Set([...fromSingular, ...fromEdges])]
        return { ...n, data: { ...n.data, input_block_ids: ids } }
      })

      // Fill a missing single input (input_block_id) from the flow's connections.
      // Template-built flows and older projects may lack it; the backend resolves
      // inputs from edges as well, so this only keeps the settings panel accurate.
      loadedNodes = loadedNodes.map(n => {
        if (!ANALYSIS_NODE_TYPES.has(n.type) || n.type === 'themeIdent' || n.data?.input_block_id) return n
        const upstream = findUpstreamAnalysisBlock(n.id, loadedNodes, loadedEdges)
        return upstream ? { ...n, data: { ...n.data, input_block_id: upstream.id } } : n
      })

      // Initialise blockOrder: restore from saved order, fill any missing ids, drop deleted ids
      const primaryNodeIds = new Set(loadedNodes.filter(n => n.type !== 'humanReview').map(n => n.id))
      const savedOrder = (data.blockOrder || []).filter(id => primaryNodeIds.has(id))
      const inSavedOrder = new Set(savedOrder)
      const missing = loadedNodes
        .filter(n => n.type !== 'humanReview' && !inSavedOrder.has(n.id))
        .map(n => n.id)
      setBlockOrder([...savedOrder, ...missing])

      setNodes(loadedNodes)
      flowLoadedRef.current = true
      setEdges(loadedEdges)
      // Set counter beyond existing IDs
      const maxId = loadedNodes.reduce((max, n) => {
        const num = parseInt(n.id.replace(/\D/g, ''))
        return num > max ? num : max
      }, 0) || 0
      nodeIdCounter = maxId + 1
    } catch (err) {
      console.error('Failed to load flow:', err)
    }
  }

  const onConnect = useCallback((params) => {
    const sourceNode = nodes.find(n => n.id === params.source)
    const targetNode = nodes.find(n => n.id === params.target)

    // Category Builder groups a theme list; Theme Identification groups coded units.
    if (sourceNode && targetNode && ANALYSIS_NODE_TYPES.has(sourceNode.type)) {
      if (targetNode.type === 'categoryBuild' && sourceNode.type !== 'themeIdent') {
        setValidationErrors(['Category Builder needs a Theme Identification block as its input. Route open-coding or rubric results through Theme Identification first.'])
        return
      }
      if (targetNode.type === 'themeIdent' && !['sourceAnalysis', 'rubricAnalysis'].includes(sourceNode.type)) {
        setValidationErrors(['Theme Identification reads coded units from Open-Coding or Rubric blocks.'])
        return
      }
    }

    if (sourceNode && targetNode &&
        ANALYSIS_NODE_TYPES.has(sourceNode.type) &&
        ANALYSIS_NODE_TYPES.has(targetNode.type)) {
      // Place humanReview node to the right of the midpoint of the vertical line
      // The main line goes from the bottom-center of source to the top-center of target
      const srcW = sourceNode.measured?.width ?? 200
      const srcH = sourceNode.measured?.height ?? 80
      const bottomCenterX = sourceNode.position.x + srcW / 2
      const y1 = sourceNode.position.y + srcH        // bottom of source
      const y2 = targetNode.position.y               // top of target
      const tapY = (y1 + y2) / 2

      const reviewId = `review_${nodeIdCounter++}`
      const reviewNode = {
        id: reviewId,
        type: 'humanReview',
        position: { x: bottomCenterX + 80, y: tapY - 28 },
        data: {
          label: 'Human Review',
          upstream_block_id: params.source,
          upstream_block_type: sourceNode.type,
          upstream_block_label: sourceNode.data?.label || params.source,
        },
      }

      setNodes(nds => [...nds, reviewNode])
      setEdges(eds => {
        const teeEdge = {
          id: `e-${params.source}-${params.target}`,
          source: params.source,
          target: params.target,
          type: 'tee',
          data: { humanReviewId: reviewId },
        }
        const updatedEdges = [...eds, teeEdge]
        if (targetNode.type === 'themeIdent') {
          // Multi-input: append source to input_block_ids array
          setNodes(nds => nds.map(n =>
            n.id === params.target
              ? { ...n, data: { ...n.data, input_block_ids: [...(n.data.input_block_ids || []), params.source] } }
              : n
          ))
        } else {
          // Single-input: set input_block_id as before
          const upstream = findUpstreamAnalysisBlock(params.target, [...nodes, reviewNode], updatedEdges)
          if (upstream && ANALYSIS_NODE_TYPES.has(targetNode.type)) {
            setNodes(nds => nds.map(n =>
              n.id === params.target ? { ...n, data: { ...n.data, input_block_id: upstream.id } } : n
            ))
          }
        }
        return updatedEdges
      })
    } else {
      setEdges(eds => {
        const updatedEdges = addEdge({ ...params, type: 'custom' }, eds)
        if (targetNode && ANALYSIS_NODE_TYPES.has(targetNode.type)) {
          const upstream = findUpstreamAnalysisBlock(params.target, nodes, updatedEdges)
          if (upstream) {
            setNodes(nds => nds.map(n =>
              n.id === params.target ? { ...n, data: { ...n.data, input_block_id: upstream.id } } : n
            ))
          }
        }
        return updatedEdges
      })
    }
  }, [nodes, setNodes, setEdges])

  const onEdgesChangeWithClear = useCallback((changes) => {
    const removals = changes.filter(c => c.type === 'remove')
    if (removals.length > 0) {
      setEdges(currentEdges => {
        for (const removal of removals) {
          const edge = currentEdges.find(e => e.id === removal.id)
          if (!edge) continue
          // When a tee edge is removed, also delete its humanReview node
          if (edge.type === 'tee' && edge.data?.humanReviewId) {
            setNodes(nds => nds.filter(n => n.id !== edge.data.humanReviewId))
          }
          // Clear input fields on affected analysis targets
          const targetNode = nodes.find(n => n.id === edge.target)
          if (targetNode?.type === 'themeIdent') {
            // Multi-input: filter out removed source from input_block_ids
            setNodes(nds => nds.map(n =>
              n.id === edge.target
                ? { ...n, data: { ...n.data, input_block_ids: (n.data.input_block_ids || []).filter(id => id !== edge.source) } }
                : n
            ))
          } else if (targetNode && ANALYSIS_NODE_TYPES.has(targetNode.type)) {
            // Single-input: recalculate input_block_id
            const remainingEdges = currentEdges.filter(e => e.id !== removal.id)
            const upstream = findUpstreamAnalysisBlock(edge.target, nodes, remainingEdges)
            setNodes(nds => nds.map(n =>
              n.id === edge.target
                ? { ...n, data: { ...n.data, input_block_id: upstream ? upstream.id : undefined } }
                : n
            ))
          }
        }
        return currentEdges
      })
    }
    onEdgesChange(changes)
  }, [nodes, edges, onEdgesChange, setEdges, setNodes])

  async function handleSave() {
    try {
      await saveFlow(projectId, { nodes, edges, blockOrder })
    } catch (err) {
      console.error('Failed to save flow:', err)
    }
  }

  async function handleValidate() {
    try {
      const res = await validateFlow(projectId)
      setValidationErrors(res.data.errors || [])
    } catch (err) {
      setValidationErrors([err.response?.data?.errors?.[0] || 'Validation failed'])
    }
  }

  const refreshReviews = useCallback(() => {
    if (!projectId) return
    getReviews(projectId).then(res => setReviews(res.data || {})).catch(() => {})
  }, [projectId])

  useEffect(() => { refreshReviews() }, [refreshReviews])

  // Track whole-pipeline runs: pauses at review checkpoints, failures, final report.
  useEffect(() => {
    function onStarted(data) {
      if (data.project_id !== projectId) return
      setIsRunning(true)
      if (!data.block_id) setPipeline({ state: 'running' })
    }
    function onBlockComplete() { refreshReviews() }
    function onComplete(data) {
      if (data && data.project_id && data.project_id !== projectId) return
      setIsRunning(false)
      refreshReviews()
      setPipeline(prev => {
        if (data?.paused) return { state: 'paused', ...data.paused }
        if (data?.error) return { state: 'error', error: data.error }
        if (prev.state === 'running') return { state: 'complete', report: data?.report }
        return prev
      })
      if (data?.paused?.review_id) {
        const reviewNode = nodesRef.current.find(n => n.id === data.paused.review_id)
        if (reviewNode) setSelectedNode(reviewNode)
      }
      if (data?.report) {
        setNodes(nds => nds.map(n => n.type === 'outputsReport'
          ? { ...n, data: { ...n.data, reportPath: `reports/${data.report}` } } : n))
      }
    }
    socket.on('analysis_started', onStarted)
    socket.on('block_complete', onBlockComplete)
    socket.on('analysis_complete', onComplete)
    return () => {
      socket.off('analysis_started', onStarted)
      socket.off('block_complete', onBlockComplete)
      socket.off('analysis_complete', onComplete)
    }
  }, [projectId, refreshReviews, setNodes])

  async function handleRun() {
    setIsRunning(true)
    setValidationErrors([])
    setPipeline({ state: 'running' })
    try {
      await handleSave()
      await runAnalysis(projectId)
    } catch (err) {
      console.error('Failed to start analysis:', err)
      setIsRunning(false)
      setPipeline({ state: 'error', error: err.response?.data?.error || 'Could not start the pipeline.' })
    }
  }

  async function handleStop() {
    try {
      await stopAnalysis(projectId)
    } catch (err) {
      console.error('Failed to stop analysis:', err)
    }
  }

  async function handleApproveReview(reviewId, note, { continueRun = false } = {}) {
    const res = await approveReview(projectId, reviewId, note)
    refreshReviews()
    if (continueRun) await handleRun()
    return res.data
  }

  async function handleRevokeReview(reviewId) {
    await revokeReview(projectId, reviewId)
    refreshReviews()
  }

  async function handleRunBlock(blockId) {
    await handleSave()
    return runAnalysis(projectId, blockId) // propagate HTTP errors to caller
  }

  async function handleResumeBlock(blockId) {
    await handleSave()
    return resumeAnalysis(projectId, blockId) // propagate HTTP errors to caller
  }

  function addNode(type) {
    const id = `${type}_${nodeIdCounter++}`
    const labels = {
      projectSpec: 'Project Spec',
      sourceAnalysis: 'Open-Coding Analysis',
      rubricAnalysis: 'Rubric-Based Analysis',
      themeIdent: 'Theme Identification',
      categoryBuild: 'Category Builder',
      customPrompt: 'Custom Prompt',
      outputsReport: 'Outputs & Report',
    }

    // Place new node in a clear spot within the visible canvas area.
    const wrapper = reactFlowWrapper.current
    let position = { x: 250, y: 100 + nodes.length * 120 }

    // Screen-pixel margins that exclude the fixed UI overlays:
    //   top-left  — "Add Block" panel (~160 × 220 px when expanded)
    //   top-right — "Step Order / Validate" buttons (~210 × 40 px)
    //   bot-left  — ReactFlow Controls widget (~40 × 130 px)
    //   bot-right — MiniMap (~210 × 160 px)
    const INSET_L = 170
    const INSET_T = 50
    const INSET_R = 220
    const INSET_B = 170

    if (wrapper) {
      const rect = wrapper.getBoundingClientRect()
      // Safe viewport center (within UI-free zone)
      position = screenToFlowPosition({
        x: rect.left + INSET_L + (rect.width - INSET_L - INSET_R) / 2,
        y: rect.top  + INSET_T + (rect.height - INSET_T - INSET_B) / 2,
      })
    }

    if (nodes.length > 0) {
      // Typical node footprint for overlap detection. ReactFlow populates
      // node.measured after first render; fall back to a conservative estimate.
      const NODE_W = 220
      const NODE_H = 130
      const GAP = 30
      const stepX = NODE_W + GAP
      const stepY = NODE_H + GAP

      function overlaps(pos) {
        return nodes.some(n => {
          const nw = (n.measured?.width ?? n.width ?? NODE_W) + GAP
          const nh = (n.measured?.height ?? n.height ?? NODE_H) + GAP
          return (
            pos.x < n.position.x + nw &&
            pos.x + NODE_W > n.position.x - GAP &&
            pos.y < n.position.y + nh &&
            pos.y + NODE_H > n.position.y - GAP
          )
        })
      }

      if (overlaps(position)) {
        let found = false

        if (wrapper) {
          const rect = wrapper.getBoundingClientRect()
          // Clamp candidate area to the UI-free safe zone.
          const safeMin = screenToFlowPosition({ x: rect.left + INSET_L, y: rect.top + INSET_T })
          const safeMax = screenToFlowPosition({ x: rect.right - INSET_R, y: rect.bottom - INSET_B })

          // Build a grid of candidate positions across the safe zone and sort
          // them by distance from centre so the nearest open slot wins.
          const cx = (safeMin.x + safeMax.x) / 2
          const cy = (safeMin.y + safeMax.y) / 2
          const candidates = []
          for (let y = safeMin.y; y + NODE_H <= safeMax.y; y += stepY) {
            for (let x = safeMin.x; x + NODE_W <= safeMax.x; x += stepX) {
              const dx = x + NODE_W / 2 - cx
              const dy = y + NODE_H / 2 - cy
              candidates.push({ x, y, dist: dx * dx + dy * dy })
            }
          }
          candidates.sort((a, b) => a.dist - b.dist)

          for (const c of candidates) {
            if (!overlaps(c)) {
              position = { x: c.x, y: c.y }
              found = true
              break
            }
          }
        }

        // Last resort (safe zone genuinely full): place below the lowest node.
        if (!found) {
          let lowestNode = nodes[0]
          for (const n of nodes) {
            const nBottom = n.position.y + (n.measured?.height ?? n.height ?? NODE_H)
            const lBottom = lowestNode.position.y + (lowestNode.measured?.height ?? lowestNode.height ?? NODE_H)
            if (nBottom > lBottom) lowestNode = n
          }
          position = {
            x: lowestNode.position.x + (lowestNode.measured?.width ?? lowestNode.width ?? NODE_W) / 2 - NODE_W / 2,
            y: lowestNode.position.y + (lowestNode.measured?.height ?? lowestNode.height ?? NODE_H) + GAP,
          }
          let attempts = 0
          while (overlaps(position) && attempts < 20) {
            position = { x: position.x, y: position.y + NODE_H + GAP }
            attempts++
          }
        }
      }
    }

    const newNode = {
      id,
      type,
      position,
      data: type === 'rubricAnalysis' ? {
        label: 'Rubric-Based Analysis',
        rubric_items: [
          { title: '', description: '', scoring_prompt: '' },
          { title: '', description: '', scoring_prompt: '' },
          { title: '', description: '', scoring_prompt: '' },
        ],
        label_threshold: 70,
        unit_type: 'sentence',
        source_type: 'all',
      } : type === 'projectSpec' ? {
        label: 'Project Spec',
        temperature: 0,
        seed: 5,
        top_k: 3,
        top_p: 0.9,
        repeat_penalty: 1.0,
      } : { label: labels[type] || type },
    }
    setNodes(nds => [...nds, newNode])
    if (type !== 'humanReview') {
      setBlockOrder(prev => [...prev, id])
    }
  }

  function onNodeClick(_event, node) {
    setSelectedNode(node)
  }

  function handleNodeDataUpdate(nodeId, newData) {
    setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...newData } } : n))
  }

  function handleDeleteNode(nodeId) {
    setEdges(eds => eds
      .filter(e => e.source !== nodeId && e.target !== nodeId)
      // If a humanReview node is deleted, clear its reference from any tee edge
      .map(e => e.type === 'tee' && e.data?.humanReviewId === nodeId
        ? { ...e, data: { ...e.data, humanReviewId: null } }
        : e
      )
    )
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setBlockOrder(prev => prev.filter(id => id !== nodeId))
    setSelectedNode(null)
  }

  function moveBlockUp(id) {
    // Capture edges at call time (outside functional update) to avoid stale closure risk
    const currentEdges = edges
    const currentNodes = nodes
    setBlockOrder(prev => {
      const visible = prev.filter(bid => {
        const n = currentNodes.find(n => n.id === bid)
        return n && !STEP_ORDER_EXCLUDED.has(n.type)
      })
      const pos = visible.indexOf(id)
      if (pos <= 0) return prev
      const swapWith = visible[pos - 1]
      // Block the move if `id` depends on `swapWith` (path swapWith → id exists)
      if (hasPath(swapWith, id, currentEdges)) return prev
      const next = [...prev]
      const ia = next.indexOf(id)
      const ib = next.indexOf(swapWith)
      ;[next[ia], next[ib]] = [next[ib], next[ia]]
      return next
    })
  }

  function moveBlockDown(id) {
    const currentEdges = edges
    const currentNodes = nodes
    setBlockOrder(prev => {
      const visible = prev.filter(bid => {
        const n = currentNodes.find(n => n.id === bid)
        return n && !STEP_ORDER_EXCLUDED.has(n.type)
      })
      const pos = visible.indexOf(id)
      if (pos < 0 || pos >= visible.length - 1) return prev
      const swapWith = visible[pos + 1]
      // Block the move if `swapWith` depends on `id` (path id → swapWith exists)
      if (hasPath(id, swapWith, currentEdges)) return prev
      const next = [...prev]
      const ia = next.indexOf(id)
      const ib = next.indexOf(swapWith)
      ;[next[ia], next[ib]] = [next[ib], next[ia]]
      return next
    })
  }

  return (
    <FlowOrderContext.Provider value={sequenceOrder}>
    <ReviewStatusContext.Provider value={reviews}>
    <div className="h-full w-full relative" ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeWithClear}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ maxZoom: 0.85 }}
        defaultEdgeOptions={{ type: 'custom' }}
      >
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'projectSpec') return '#3b82f6'
            if (n.type === 'outputsReport') return '#10b981'
            if (n.type === 'humanReview') return '#e11d48'
            return '#6366f1'
          }}
        />
        <Background color="#94a3b8" gap={20} size={1.8} />

        <Panel position="top-left">
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
            <button
              onClick={() => setAddBlockExpanded(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-gray-500 text-xs font-semibold uppercase hover:bg-gray-50 rounded-lg transition-colors"
            >
              Add Block
              <svg
                className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${addBlockExpanded ? '' : 'rotate-180'}`}
                viewBox="0 0 20 20" fill="currentColor"
              >
                <path fillRule="evenodd" d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.832l-3.71 3.938a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06z" clipRule="evenodd" />
              </svg>
            </button>
            {addBlockExpanded && (
              <div className="px-3 pb-3 space-y-2 border-t border-gray-100 pt-2">
                <button onClick={() => addNode('projectSpec')} className="block w-full text-left text-xs px-2 py-1 text-blue-700 hover:bg-gray-100 rounded">
                  Project Spec (Start)
                </button>
                <button onClick={() => addNode('sourceAnalysis')} className="block w-full text-left text-xs px-2 py-1 text-indigo-600 hover:bg-gray-100 rounded">
                  Open-Coding Analysis
                </button>
                <button onClick={() => addNode('rubricAnalysis')} className="block w-full text-left text-xs px-2 py-1 text-indigo-600 hover:bg-gray-100 rounded">
                  Rubric-Based Analysis
                </button>
                <button onClick={() => addNode('themeIdent')} className="block w-full text-left text-xs px-2 py-1 text-indigo-600 hover:bg-gray-100 rounded">
                  Theme Identification
                </button>
                <button onClick={() => addNode('categoryBuild')} className="block w-full text-left text-xs px-2 py-1 text-indigo-600 hover:bg-gray-100 rounded">
                  Category Builder
                </button>
                <button onClick={() => addNode('customPrompt')} className="block w-full text-left text-xs px-2 py-1 text-indigo-600 hover:bg-gray-100 rounded">
                  Custom Prompt
                </button>
                <button onClick={() => addNode('outputsReport')} className="block w-full text-left text-xs px-2 py-1 text-emerald-700 hover:bg-gray-100 rounded">
                  Outputs & Report (End)
                </button>
              </div>
            )}
          </div>
        </Panel>

        <Panel position="top-right">
          {/* Top row: Step Order (left) + Validate (right) */}
          <div className="flex items-start gap-2 mb-2">
            {/* Step Order */}
            {(() => {
              const orderedBlocks = blockOrder
                .map(id => nodes.find(n => n.id === id))
                .filter(n => n && !STEP_ORDER_EXCLUDED.has(n.type))
              return (
                <div className="relative">
                  <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
                    <button
                      onClick={() => setStepOrderExpanded(v => !v)}
                      className="flex items-center gap-1.5 px-2 py-1 text-gray-500 text-xs font-semibold uppercase hover:bg-gray-50 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Step Order
                      <svg
                        className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${stepOrderExpanded ? '' : 'rotate-180'}`}
                        viewBox="0 0 20 20" fill="currentColor"
                      >
                        <path fillRule="evenodd" d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.832l-3.71 3.938a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {stepOrderExpanded && (
                    <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-sm min-w-[200px] z-10 py-1">
                      {orderedBlocks.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-gray-400 italic">No blocks added yet.</p>
                      ) : (
                        orderedBlocks.map((n, idx) => {
                          const seqNum = sequenceOrder[n.id]
                          const isFirst = idx === 0
                          const isLast = idx === orderedBlocks.length - 1
                          const prevBlock = isFirst ? null : orderedBlocks[idx - 1]
                          const nextBlock = isLast ? null : orderedBlocks[idx + 1]
                          const canMoveUp = !isFirst && !hasPath(prevBlock.id, n.id, edges)
                          const canMoveDown = !isLast && !hasPath(n.id, nextBlock.id, edges)
                          return (
                            <div key={n.id} className="flex items-center gap-1 mx-1 px-1 py-1 rounded hover:bg-gray-50">
                              <div className="flex flex-col shrink-0">
                                <button
                                  onClick={() => moveBlockUp(n.id)}
                                  className={`leading-none px-0.5 ${canMoveUp ? 'text-gray-300 hover:text-indigo-500' : 'invisible'}`}
                                  title="Move up"
                                >▲</button>
                                <button
                                  onClick={() => moveBlockDown(n.id)}
                                  className={`leading-none px-0.5 ${canMoveDown ? 'text-gray-300 hover:text-indigo-500' : 'invisible'}`}
                                  title="Move down"
                                >▼</button>
                              </div>
                              <span className={`w-2 h-2 rounded-full shrink-0 ${STEP_TYPE_DOT[n.type] || 'bg-gray-400'}`} />
                              {seqNum != null
                                ? <span className="shrink-0 text-[10px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">{seqNum}</span>
                                : <span className="shrink-0 text-[10px] font-bold px-1 py-0.5 rounded bg-red-100 text-red-400">–</span>
                              }
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-gray-800 truncate">{n.data?.label || n.id}</p>
                                <p className="text-[10px] font-mono text-gray-400 truncate">{n.id}</p>
                              </div>
                            </div>
                          )
                        })
                      )}
                      <p className="px-3 pt-1 pb-1.5 text-[10px] text-gray-400 italic">↑↓ to reorder parallel blocks.</p>
                    </div>
                  )}
                </div>
              )
            })()}
            {/* Run the whole pipeline */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
              {isRunning ? (
                <button onClick={handleStop} className="block px-2 py-1 text-xs bg-red-50 text-red-700 rounded-lg hover:bg-red-100 whitespace-nowrap">
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleRun}
                  title="Run every block in order. The run pauses at each Human Review checkpoint until you approve it."
                  className="block px-2 py-1 text-xs bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 whitespace-nowrap"
                >
                  Run pipeline
                </button>
              )}
            </div>
            {/* Validate */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
              <button onClick={handleValidate} className="block px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 whitespace-nowrap">
                Validate
              </button>
            </div>
            {/* Autosave status — block settings/canvas changes save automatically */}
            {autosaveStatus !== 'idle' && (
              <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-2 py-1 flex items-center">
                <span className="text-xs whitespace-nowrap">
                  {autosaveStatus === 'saving' && <span className="text-gray-400">Saving…</span>}
                  {autosaveStatus === 'saved' && <span className="text-emerald-600">All changes saved</span>}
                  {autosaveStatus === 'error' && <span className="text-red-600">Autosave failed — click Save Project to retry</span>}
                </span>
              </div>
            )}
          </div>
          {pipeline.state !== 'idle' && (
            <div className={`mb-2 max-w-sm rounded-lg p-3 text-xs border ${
              pipeline.state === 'error' ? 'bg-red-50 border-red-200 text-red-700'
              : pipeline.state === 'paused' ? 'bg-amber-50 border-amber-200 text-amber-800'
              : pipeline.state === 'complete' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-white border-gray-200 text-gray-600'}`}>
              {pipeline.state === 'running' && 'Pipeline running. Follow progress in the Activity Log.'}
              {pipeline.state === 'paused' && (() => {
                const up = nodes.find(n => n.id === pipeline.upstream_block_id)
                return <>Paused for human review of <strong>{up?.data?.label || pipeline.upstream_block_id}</strong>. Check its results in the review panel, then click <strong>Approve and continue</strong>.</>
              })()}
              {pipeline.state === 'error' && <>Pipeline stopped. {pipeline.error}</>}
              {pipeline.state === 'complete' && <>Pipeline complete.{pipeline.report ? <> Final report: <code>reports/{pipeline.report}</code></> : null}</>}
              {pipeline.state !== 'running' && (
                <button onClick={() => setPipeline({ state: 'idle' })} className="ml-2 underline opacity-70 hover:opacity-100">Dismiss</button>
              )}
            </div>
          )}
          {validationErrors.length > 0 && (
            <div className="mb-2 bg-red-50 border border-red-200 rounded-lg p-3">
              {validationErrors.map((err, i) => (
                <p key={i} className="text-red-600 text-xs">{err}</p>
              ))}
            </div>
          )}
        </Panel>
      </ReactFlow>

      {selectedNode && (
        <NodeExpandedPanel
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          projectId={projectId}
          onUpdate={(data) => handleNodeDataUpdate(selectedNode.id, data)}
          onDelete={() => handleDeleteNode(selectedNode.id)}
          onClose={() => setSelectedNode(null)}
          onRunBlock={handleRunBlock}
          onResumeBlock={handleResumeBlock}
          onOpenInData={onOpenInData}
          reviewStatus={reviews}
          onApproveReview={handleApproveReview}
          onRevokeReview={handleRevokeReview}
          pipelineState={pipeline}
          isRunning={isRunning}
        />
      )}
    </div>
    </ReviewStatusContext.Provider>
    </FlowOrderContext.Provider>
  )
})

const FlowEditor = forwardRef(function FlowEditor(props, ref) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} ref={ref} />
    </ReactFlowProvider>
  )
})

export default FlowEditor
