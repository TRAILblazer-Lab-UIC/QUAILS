import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { updateProject } from '../../api'
import FileUploader from './FileUploader'
import HelpLabel from './HelpLabel'
import AppFooter from './AppFooter'
import ConfirmDialog from './ConfirmDialog'

export default function Sidebar({ project, onReload, onSave, onToggleConsole, onNavigateAway, onFileUploaded }) {
  const navigate = useNavigate()
  const goHome = () => (onNavigateAway ? onNavigateAway('/') : navigate('/'))
  const [showUploader, setShowUploader] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState({
    title: project.title,
    description: project.description || '',
    unit_type: project.unit_type || 'sentence',
    include_headers: project.include_headers || false,
    context_window: project.context_window || 1,
    detection_threshold: project.thresholds?.detection || 70,
    label_threshold: project.thresholds?.label || 70,
    theme_threshold: project.thresholds?.theme || 80,
    max_categories: project.max_categories || 6,
    parallel_analysis_slots: project.parallel_analysis_slots || 1,
  })
  const [confirmParallel, setConfirmParallel] = useState(null)

  async function handleSettingsSave() {
    try {
      await updateProject(project.id, {
        title: settings.title,
        description: settings.description,
        unit_type: settings.unit_type,
        include_headers: settings.include_headers,
        context_window: settings.context_window,
        llm: { ...project.llm },
        thresholds: {
          detection: settings.detection_threshold,
          label: settings.label_threshold,
          theme: settings.theme_threshold,
        },
        max_categories: settings.max_categories,
        parallel_analysis_slots: settings.parallel_analysis_slots,
      })
      onReload()
      setShowSettings(false)
    } catch (err) {
      console.error('Settings save failed:', err)
    }
  }

  return (
    <div className="w-60 bg-white border-r border-gray-200 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <button onClick={goHome} className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm mb-2">
          <img src="/logo.png" alt="Logo for the QUAILS system" className="h-5" />
          <span>&larr; Projects</span>
        </button>
        <h2 className="text-gray-900 font-semibold truncate">{project.title}</h2>
        <p className="text-gray-500 text-xs mt-1">ID: {project.id}</p>
      </div>

      {/* Actions */}
      <div className="p-4 space-y-2">
        <button
          onClick={() => setShowUploader(!showUploader)}
          className="w-full px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 transition-colors"
        >
          Add Documents
        </button>
        <button
          onClick={onSave}
          className="w-full px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
        >
          Save Project
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="w-full px-3 py-2 text-sm bg-gray-50 text-gray-600 rounded hover:bg-gray-100 transition-colors"
        >
          Settings
        </button>
      </div>

      {showUploader && (
        <div className="p-4 border-t border-gray-200">
          <FileUploader projectId={project.id} onUpload={() => { setShowUploader(false); onReload() }} onFileUploaded={onFileUploaded} />
        </div>
      )}

      {showSettings && (
        <div className="p-4 border-t border-gray-200 overflow-y-auto flex-1">
          <h3 className="text-gray-900 text-sm font-semibold mb-3">Project Settings</h3>
          <div className="space-y-3">
            <label className="block">
              <HelpLabel label="Title" help="The name of your project, displayed on the project list." />
              <input
                value={settings.title}
                onChange={(e) => setSettings({ ...settings, title: e.target.value })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <label className="block">
              <HelpLabel label="Unit Type" help='How documents are split for analysis. "Sentence" splits by sentence. "Paragraph" splits by blank lines. "Section" treats each document section (defined by headings) as one unit. "Document" treats each file as one unit. "Line" uses individual rows (best for CSV/Excel).' />
              <select
                value={settings.unit_type}
                onChange={(e) => setSettings({ ...settings, unit_type: e.target.value })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              >
                <option value="sentence">Sentence</option>
                <option value="paragraph">Paragraph</option>
                <option value="section">Section</option>
                <option value="document">Document</option>
                <option value="line">Line (CSV)</option>
              </select>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.include_headers}
                onChange={(e) => setSettings({ ...settings, include_headers: e.target.checked })}
                className="mt-0.5 rounded border-gray-300 bg-gray-50 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-xs text-gray-600 leading-snug">
                Include section headers in analysis
                <span className="block text-gray-400">Headers detected from document structure (Markdown, DOCX headings, HTML h1–h6)</span>
              </span>
            </label>
            <label className="block">
              <HelpLabel
                label="Parallel analysis"
                help="Sends several units to Ollama at once (needs Ollama's OLLAMA_NUM_PARALLEL to match — see AI Settings → Hardware & performance). Faster on GPU / unified-memory machines, but batched requests can change results slightly, so runs are no longer byte-for-byte replicable. Off (1) is recommended for research analyses."
              />
              <select
                value={settings.parallel_analysis_slots}
                onChange={(e) => {
                  const v = parseInt(e.target.value)
                  if (v > 1 && settings.parallel_analysis_slots === 1) setConfirmParallel(v)
                  else setSettings({ ...settings, parallel_analysis_slots: v })
                }}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              >
                <option value={1}>Off — one unit at a time (replicable)</option>
                <option value={2}>2 units at once</option>
                <option value={4}>4 units at once</option>
              </select>
              {settings.parallel_analysis_slots > 1 && (
                <span className="block text-[11px] text-amber-700 mt-1">On: analysis outputs are not guaranteed to be replicable byte-for-byte.</span>
              )}
            </label>
            {confirmParallel && (
              <ConfirmDialog
                title="Turn on parallel analysis?"
                message={`Analyses will send ${confirmParallel} units to the model at once. This is faster on GPU and unified-memory machines, but batched requests can change the model's arithmetic, so outputs (labels, scores, confidence values) may differ slightly from a one-at-a-time run and cannot be claimed as byte-for-byte replicable. Every run records this setting. Keep it off for analyses you will report.`}
                onConfirm={() => { setSettings(s => ({ ...s, parallel_analysis_slots: confirmParallel })); setConfirmParallel(null) }}
                onCancel={() => setConfirmParallel(null)}
              />
            )}
            <label className="block">
              <HelpLabel label="Context Window" help="Number of surrounding units (before and after) included as context when the LLM analyzes each unit. Higher values give more context but slow processing. 0 means no extra context." />
              <input
                type="number"
                min="0"
                max="10"
                value={settings.context_window}
                onChange={(e) => setSettings({ ...settings, context_window: parseInt(e.target.value) || 0 })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>

            <label className="block">
              <HelpLabel label="Detection Threshold (%)" help="Minimum confidence score (0-100) for a unit to be considered relevant. Units below this threshold are marked as not detected. Higher values are stricter." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={settings.detection_threshold}
                onChange={(e) => setSettings({ ...settings, detection_threshold: parseFloat(e.target.value) })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <label className="block">
              <HelpLabel label="Label Threshold (%)" help="Minimum confidence score (0-100) for an assigned label to be accepted. Labels below this threshold are flagged as low-confidence. Higher values are stricter." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={settings.label_threshold}
                onChange={(e) => setSettings({ ...settings, label_threshold: parseFloat(e.target.value) })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <label className="block">
              <HelpLabel label="Theme Threshold (%)" help="Minimum confidence score (0-100) for assigning a label to a theme. Higher values require stronger association between labels and themes." />
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={settings.theme_threshold}
                onChange={(e) => setSettings({ ...settings, theme_threshold: parseFloat(e.target.value) })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <label className="block">
              <HelpLabel label="Max Categories" help="Maximum number of top-level categories the Category Builder will create. Themes are grouped into up to this many categories." />
              <input
                type="number"
                min="1"
                max="20"
                value={settings.max_categories}
                onChange={(e) => setSettings({ ...settings, max_categories: parseInt(e.target.value) || 6 })}
                className="w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
              />
            </label>
            <button
              onClick={handleSettingsSave}
              className="w-full px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500"
            >
              Save Settings
            </button>
          </div>
        </div>
      )}
      <div className="mt-auto">
        <AppFooter compact onNavigate={onNavigateAway} />
      </div>
    </div>
  )
}
