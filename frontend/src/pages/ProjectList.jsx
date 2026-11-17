import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { listProjects, createProject, deleteProject, exportProject, importProject } from '../api'
import ConfirmDialog from '../components/common/ConfirmDialog'
import AppFooter from '../components/common/AppFooter'

export default function ProjectList() {
  const [projects, setProjects] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState('basic_thematic')
  const [deleteTarget, setDeleteTarget] = useState(null)   // { id, title }
  const [deleteInput, setDeleteInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  // Export modal
  const [exportTarget, setExportTarget] = useState(null)  // { id, title }
  const [exportIncludeData, setExportIncludeData] = useState(false)
  const [exportIncludeAlignment, setExportIncludeAlignment] = useState(true)
  const [exportEncrypt, setExportEncrypt] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState('')

  // Import modal
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importPassword, setImportPassword] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')

  const navigate = useNavigate()

  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    try {
      const res = await listProjects()
      setProjects(res.data)
    } catch (err) {
      console.error('Failed to load projects:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setCreateError('')
    try {
      const res = await createProject({ title, description, template })
      navigate(`/project/${res.data.id}`)
    } catch (err) {
      console.error('Failed to create project:', err)
      setCreateError('Failed to create project. Is the backend running?')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteProject(deleteTarget.id)
      setDeleteTarget(null)
      setDeleteInput('')
      loadProjects()
    } catch (err) {
      console.error('Failed to delete project:', err)
    }
  }

  function openDeleteTarget(project) {
    setDeleteTarget({ id: project.id, title: project.title })
    setDeleteInput('')
  }

  function closeDeleteTarget() {
    setDeleteTarget(null)
    setDeleteInput('')
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function openExport(project) {
    setExportTarget({ id: project.id, title: project.title })
    setExportIncludeData(false)
    setExportIncludeAlignment(true)
    setExportEncrypt(false)
    setExportPassword('')
    setExportPasswordConfirm('')
    setExportError('')
  }

  function closeExport() {
    setExportTarget(null)
    setExportError('')
  }

  async function handleExport() {
    if (!exportTarget) return
    if (exportEncrypt) {
      if (!exportPassword) { setExportError('Enter a password.'); return }
      if (exportPassword !== exportPasswordConfirm) { setExportError('Passwords do not match.'); return }
    }
    setExportBusy(true)
    setExportError('')
    try {
      const res = await exportProject(exportTarget.id, {
        include_data: exportIncludeData,
        include_alignment: exportIncludeAlignment,
        password: exportEncrypt ? exportPassword : null,
      })
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/zip' }))
      const a = document.createElement('a')
      const safeTitle = exportTarget.title.replace(/[^a-zA-Z0-9 _-]/g, '_')
      a.href = url
      a.download = `${safeTitle}_${exportTarget.id}.qpkg`
      a.click()
      URL.revokeObjectURL(url)
      closeExport()
    } catch (err) {
      setExportError('Export failed. Please try again.')
      console.error('Export error:', err)
    } finally {
      setExportBusy(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  function openImport() {
    setImportOpen(true)
    setImportFile(null)
    setImportPassword('')
    setImportError('')
    setImportSuccess('')
  }

  function closeImport() {
    setImportOpen(false)
    setImportError('')
    setImportSuccess('')
  }

  async function handleImport() {
    if (!importFile) { setImportError('Please select a file.'); return }
    setImportBusy(true)
    setImportError('')
    setImportSuccess('')
    const formData = new FormData()
    formData.append('file', importFile)
    if (importPassword) formData.append('password', importPassword)
    try {
      const res = await importProject(formData)
      const m = res.data?.snapshot_model
      setImportSuccess('Project imported successfully!' + (m ? ` Its alignment tests were run with model "${m}" — select the same model in AI Settings to reproduce them.` : ''))
      loadProjects()
      setTimeout(() => closeImport(), m ? 6000 : 1500)
    } catch (err) {
      const data = err.response?.data
      if (data?.error === 'password_required') {
        setImportError('This package is encrypted — please enter the password.')
      } else {
        setImportError(data?.error || 'Import failed. Please try again.')
      }
    } finally {
      setImportBusy(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <img src="/logo.png" alt="Logo for the QUAILS system" className="h-12" />
            <p className="text-gray-600 mt-1">Qualitative AI Labeling Support</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/about')}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              About
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              AI Settings
            </button>
            <button
              onClick={openImport}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Import Project
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
            >
              New Project
            </button>
          </div>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="mb-8 p-6 bg-white rounded-lg border border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Create New Project</h2>
            <input
              type="text"
              placeholder="Project title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full mb-3 px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500"
              autoFocus
              required
            />
            <textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full mb-4 px-3 py-2 bg-gray-50 border border-gray-300 rounded text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500"
              rows={2}
            />
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Project template</label>
              <div className="space-y-2">
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  template === 'basic_thematic' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}>
                  <input
                    type="radio"
                    name="template"
                    value="basic_thematic"
                    checked={template === 'basic_thematic'}
                    onChange={() => setTemplate('basic_thematic')}
                    className="mt-0.5 accent-indigo-600"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-900">Basic Thematic Analysis</span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Pre-configured pipeline: Project Spec &rarr; Open Coding &rarr; Theme Identification &rarr; Category Builder &rarr; Report. Recommended for most qualitative analysis projects.
                    </p>
                  </div>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  template === 'blank' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}>
                  <input
                    type="radio"
                    name="template"
                    value="blank"
                    checked={template === 'blank'}
                    onChange={() => setTemplate('blank')}
                    className="mt-0.5 accent-indigo-600"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-900">Blank project</span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Start with an empty canvas and build your own analysis pipeline from scratch.
                    </p>
                  </div>
                </label>
              </div>
            </div>
            {createError && (
              <p className="text-red-600 text-sm mb-3">{createError}</p>
            )}
            <div className="flex gap-2">
              <button type="submit" disabled={creating} className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed">
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button type="button" disabled={creating} onClick={() => { setShowCreate(false); setCreateError('') }} className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50">
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="text-center text-gray-500 py-12">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16 bg-white/50 rounded-lg border border-gray-200">
            <p className="text-gray-600 text-lg">No projects yet</p>
            <p className="text-gray-500 mt-2">Create a new project to get started</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {projects.map((project) => (
              <div
                key={project.id}
                className="p-4 bg-white rounded-lg border border-gray-200 hover:border-indigo-500 transition-colors cursor-pointer flex items-center justify-between"
                onClick={() => navigate(`/project/${project.id}`)}
              >
                <div>
                  <h3 className="text-gray-900 font-medium">{project.title}</h3>
                  {project.description && (
                    <p className="text-gray-600 text-sm mt-1">{project.description}</p>
                  )}
                  <p className="text-gray-500 text-xs mt-2">
                    Updated: {new Date(project.updated_at).toLocaleDateString('en-US')}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => openExport(project)}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                    title="Export project"
                  >
                    Export
                  </button>
                  <button
                    onClick={() => openDeleteTarget(project)}
                    className="text-gray-500 hover:text-red-600 p-2"
                    title="Delete project"
                  >
                    &#x2715;
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <AppFooter />
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete Project"
          message={`Are you sure you want to delete "${deleteTarget.title}"? This will permanently delete the project and all its data. Type DELETE to confirm.`}
          requireTyped={true}
          confirmWord="DELETE"
          onConfirm={handleDelete}
          onCancel={closeDeleteTarget}
        />
      )}

      {/* Export modal */}
      {exportTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-gray-900 font-semibold text-lg">Export Project</h3>
            <p className="text-gray-600 mt-1 text-sm">{exportTarget.title}</p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportIncludeAlignment}
                    onChange={(e) => setExportIncludeAlignment(e.target.checked)}
                    className="rounded"
                  />
                  Include source files and alignment tests
                </label>
                <p className="text-xs text-gray-500 pl-6 mt-0.5">
                  Bundles the documents, parsed units, all alignment tests (samples, human codes, results),
                  and your prompt settings so someone else can import the project and continue alignment.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportIncludeData}
                  onChange={(e) => setExportIncludeData(e.target.checked)}
                  className="rounded"
                />
                Include analysis outputs (block results and reports)
              </label>

              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportEncrypt}
                  onChange={(e) => { setExportEncrypt(e.target.checked); setExportPassword(''); setExportPasswordConfirm('') }}
                  className="rounded"
                />
                Encrypt with password
              </label>

              {exportEncrypt && (
                <div className="space-y-2 pl-6">
                  <input
                    type="password"
                    placeholder="Password"
                    value={exportPassword}
                    onChange={(e) => setExportPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    type="password"
                    placeholder="Confirm password"
                    value={exportPasswordConfirm}
                    onChange={(e) => setExportPasswordConfirm(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}
            </div>

            {exportError && (
              <p className="text-red-600 text-sm mt-3">{exportError}</p>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={closeExport}
                disabled={exportBusy}
                className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={exportBusy}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {exportBusy ? 'Exporting...' : 'Export'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-gray-900 font-semibold text-lg">Import Project</h3>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Package file (.qpkg or .zip)</label>
                <input
                  type="file"
                  accept=".qpkg,.zip"
                  onChange={(e) => { setImportFile(e.target.files[0] || null); setImportError('') }}
                  className="w-full text-sm text-gray-700"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Password — leave blank if not encrypted
                </label>
                <input
                  type="password"
                  placeholder="Password (optional)"
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {importError && (
              <p className="text-red-600 text-sm mt-3">{importError}</p>
            )}
            {importSuccess && (
              <p className="text-green-600 text-sm mt-3">{importSuccess}</p>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={closeImport}
                disabled={importBusy}
                className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={importBusy}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {importBusy ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
