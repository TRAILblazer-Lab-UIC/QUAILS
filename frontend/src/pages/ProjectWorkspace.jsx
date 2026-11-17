import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getProject, saveProject, getSettingsHealth, stopAnalysis } from '../api'
import Sidebar from '../components/common/Sidebar'
import FlowEditor from '../components/flow/FlowEditor'
import CsvBrowser from '../components/data/CsvBrowser'
import DocumentViewer from '../components/viewer/DocumentViewer'
import AlignmentPanel from '../components/alignment/AlignmentPanel'
import ConsolePanel from '../components/console/ConsolePanel'
import PromptBuilderPanel from '../components/prompts/PromptBuilderPanel'
import useProject from '../hooks/useProject'
import useAutosave from '../hooks/useAutosave'
import socket from '../socket'

const TABS = [
  { id: 'flow', label: 'Analysis Builder' },
  { id: 'data', label: 'Data Browser' },
  { id: 'viewer', label: 'Document Viewer' },
  { id: 'alignment', label: 'Alignment' },
  { id: 'prompts', label: 'Default Prompt Editor' },
]

export default function ProjectWorkspace() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { project, loading, reload } = useProject(projectId)
  const [activeTab, setActiveTab] = useState('flow')
  const [showConsole, setShowConsole] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState(null)
  const [saveToast, setSaveToast] = useState(null) // null | 'saved' | 'error'
  const [llmHealth, setLlmHealth] = useState(null)
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [consoleLogs, setConsoleLogs] = useState([])
  const [consoleProgress, setConsoleProgress] = useState(null)
  const flowEditorRef = useRef(null)
  const toastTimer = useRef(null)

  useAutosave(projectId)

  // Persistent socket listeners — always active regardless of console visibility.
  // This ensures logs/progress are never dropped when the console panel is closed.
  useEffect(() => {
    function onAnalysisStarted(data) {
      if (data.project_id !== projectId) return
      setAnalysisRunning(true)
      setShowConsole(true)
    }
    function onLog(data) {
      if (data.project_id && data.project_id !== projectId) return
      setConsoleLogs(prev => [...prev.slice(-500), data])
    }
    function onProgress(data) {
      if (data.project_id && data.project_id !== projectId) return
      setConsoleProgress(data)
    }
    function onBlockComplete() {
      setConsoleProgress(null)
    }
    function onAnalysisComplete(data) {
      if (data && data.project_id && data.project_id !== projectId) return
      setAnalysisRunning(false)
      setConsoleProgress(null)
      setConsoleLogs(prev => [
        ...prev,
        { timestamp: new Date().toLocaleTimeString(), level: 'info', message: data?.error ? `Analysis ended with error: ${data.error}` : 'Analysis complete' },
      ])
    }
    function onError(data) {
      setAnalysisRunning(false)
      setConsoleLogs(prev => [
        ...prev,
        { timestamp: new Date().toLocaleTimeString(), level: 'error', message: data.message || 'Unknown error' },
      ])
    }

    function onAlignmentStarted(data) {
      if (data.project_id !== projectId) return
      setAnalysisRunning(true)
      setShowConsole(true)
    }
    function onAlignmentComplete(data) {
      if (data && data.project_id && data.project_id !== projectId) return
      setAnalysisRunning(false)
      setConsoleLogs(prev => [
        ...prev,
        { timestamp: new Date().toLocaleTimeString(), level: 'info', message: data?.error ? `Alignment test error: ${data.error}` : 'Alignment test complete' },
      ])
    }

    // Optimization jobs report through the same log/progress events; just surface the console.
    function onOptimizationStarted(data) {
      if (data.project_id !== projectId) return
      setShowConsole(true)
    }

    socket.on('analysis_started', onAnalysisStarted)
    socket.on('optimization_started', onOptimizationStarted)
    socket.on('log', onLog)
    socket.on('progress', onProgress)
    socket.on('block_complete', onBlockComplete)
    socket.on('analysis_complete', onAnalysisComplete)
    socket.on('error', onError)
    socket.on('alignment_started', onAlignmentStarted)
    socket.on('alignment_complete', onAlignmentComplete)

    return () => {
      socket.off('analysis_started', onAnalysisStarted)
      socket.off('optimization_started', onOptimizationStarted)
      socket.off('log', onLog)
      socket.off('progress', onProgress)
      socket.off('block_complete', onBlockComplete)
      socket.off('analysis_complete', onAnalysisComplete)
      socket.off('error', onError)
      socket.off('alignment_started', onAlignmentStarted)
      socket.off('alignment_complete', onAlignmentComplete)
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    async function checkHealth() {
      try {
        const res = await getSettingsHealth()
        if (!cancelled) setLlmHealth(res.data)
      } catch {
        if (!cancelled) setLlmHealth({ connected: false, error: 'Unreachable' })
      }
    }
    checkHealth()
    const interval = setInterval(checkHealth, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleSaveAll = useCallback(async () => {
    try {
      if (flowEditorRef.current) {
        await flowEditorRef.current.saveFlow()
      }
      await saveProject(projectId)
      setSaveToast('saved')
    } catch (err) {
      console.error('Save failed:', err)
      setSaveToast('error')
    }
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setSaveToast(null), 2000)
  }, [projectId])

  const [pendingPath, setPendingPath] = useState(null)
  const [pendingDataFile, setPendingDataFile] = useState(null)
  const [docRefreshKey, setDocRefreshKey] = useState(0)

  function handleOpenInData(blockId, filename) {
    setPendingDataFile({ blockId, filename })
    setActiveTab('data')
  }

  function guardedNavigate(path) {
    setPendingPath(path)
  }

  useEffect(() => {
    function handleBeforeUnload(e) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  async function handleSaveAndLeave() {
    try {
      if (flowEditorRef.current) {
        await flowEditorRef.current.saveFlow()
      }
      await saveProject(projectId)
      navigate(pendingPath)
    } catch (err) {
      console.error('Save failed:', err)
      setSaveToast('error')
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setSaveToast(null), 2000)
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading...</div>
  }

  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 text-lg">Project not found</p>
          <button onClick={() => navigate('/')} className="mt-4 text-indigo-600 hover:text-indigo-500">
            Back to projects
          </button>
        </div>
      </div>
    )
  }

  function handleUnitClick(unitId) {
    setSelectedUnit(unitId)
    setActiveTab('viewer')
  }

  return (
    <div className="min-h-screen flex relative">
      {saveToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium transition-opacity ${
          saveToast === 'saved'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {saveToast === 'saved' ? 'Project saved' : 'Save failed'}
        </div>
      )}

      {pendingPath !== null && (
        <div className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-gray-900 font-semibold text-base mb-2">Save before leaving?</h3>
            <p className="text-sm text-gray-600 mb-6">
              You have unsaved changes. Do you want to save your project before leaving?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleSaveAndLeave}
                className="w-full px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
              >
                Save &amp; Leave
              </button>
              <button
                onClick={() => { navigate(pendingPath); setPendingPath(null) }}
                className="w-full px-4 py-2 text-sm font-medium bg-white text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition-colors"
              >
                Leave without saving
              </button>
              <button
                onClick={() => setPendingPath(null)}
                className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Stay on page
              </button>
            </div>
          </div>
        </div>
      )}
      <Sidebar
        project={project}
        onReload={reload}
        onSave={handleSaveAll}
        onToggleConsole={() => setShowConsole(!showConsole)}
        onNavigateAway={guardedNavigate}
        onFileUploaded={() => setDocRefreshKey(k => k + 1)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <div className="flex border-b border-gray-200 bg-white">
          {TABS.map((tab) => {
            const isFlow = tab.id === 'flow'
            const isActive = activeTab === tab.id
            let cls = 'px-4 py-3 text-sm font-medium transition-colors '
            if (isFlow) {
              cls += isActive
                ? 'bg-indigo-600 text-white'
                : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            } else {
              cls += isActive
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-gray-500 hover:text-gray-700'
            }
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cls}
              >
                {tab.label}
              </button>
            )
          })}
          <div className="flex-1" />
          {llmHealth && (
            <button
              onClick={() => guardedNavigate('/settings')}
              className="flex items-center gap-2 px-3 text-xs hover:bg-gray-100 rounded transition-colors duration-150 cursor-pointer"
              title={
                llmHealth.connected
                  ? `${llmHealth.provider} / ${llmHealth.model} — click to manage AI settings`
                  : (llmHealth.error || 'Not connected') + ' — click to manage AI settings'
              }
            >
              <svg className={`w-4 h-4 ${llmHealth.connected ? 'text-emerald-600' : 'text-red-500'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
                <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
              </svg>
              <div className="flex flex-col leading-tight text-left">
                <span className="text-gray-500 font-medium">AI Status</span>
                <span className={llmHealth.connected ? 'text-emerald-600' : 'text-red-600'}>
                  {llmHealth.connected
                    ? `${llmHealth.model} \u2014 connected`
                    : 'offline'}
                </span>
              </div>
            </button>
          )}
          <button
            onClick={() => setShowConsole(!showConsole)}
            className={`mx-2 my-1.5 px-3 py-1.5 text-sm font-medium rounded transition-colors ${
              showConsole
                ? 'bg-blue-900 text-white'
                : 'bg-blue-900/10 text-blue-900 hover:bg-blue-900 hover:text-white'
            }`}
          >
            Activity Log
          </button>
        </div>

        {/* Analysis running banner */}
        {analysisRunning && (
          <div className="flex items-center justify-between px-4 py-1.5 bg-indigo-600 text-white text-xs font-medium shrink-0">
            <div className="flex items-center gap-2">
              <svg className="animate-spin h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <span>Analysis running — {project?.title}</span>
            </div>
            <button
              onClick={() => stopAnalysis(projectId)}
              className="px-2 py-0.5 text-xs bg-white/20 hover:bg-white/30 rounded transition-colors"
            >
              Stop
            </button>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            <div style={{ display: activeTab === 'flow' ? 'contents' : 'none' }}>
              <FlowEditor ref={flowEditorRef} projectId={projectId} onOpenInData={handleOpenInData} />
            </div>
            <div className={activeTab === 'data' ? 'h-full' : 'hidden'}>
              <CsvBrowser projectId={projectId} onUnitClick={handleUnitClick} pendingDataFile={pendingDataFile} />
            </div>
            <div className={activeTab === 'viewer' ? 'h-full' : 'hidden'}>
              <DocumentViewer projectId={projectId} selectedUnit={selectedUnit} refreshKey={docRefreshKey} />
            </div>
            <div className={activeTab === 'alignment' ? 'h-full' : 'hidden'}>
              <AlignmentPanel projectId={projectId} isActive={activeTab === 'alignment'} onShowConsole={() => setShowConsole(true)} />
            </div>
            <div className={activeTab === 'prompts' ? 'h-full' : 'hidden'}>
              <PromptBuilderPanel projectId={projectId} />
            </div>
          </div>

          {showConsole && (
            <div className="h-64 border-t border-gray-200">
              <ConsolePanel
                logs={consoleLogs}
                progress={consoleProgress}
                onClear={() => setConsoleLogs([])}
                onClose={() => setShowConsole(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
