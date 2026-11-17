import { openPath } from '../../api'

export default function OverrideConfirmModal({ blockId, blockLabel, files, projectId, onConfirm, onCancel }) {
  const existingFiles = files.filter(f => f.exists)

  async function handleOpen(relativePath) {
    try {
      await openPath(projectId, relativePath)
    } catch (err) {
      console.error('Failed to open path:', err)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-gray-900 font-semibold text-lg">Re-run will overwrite existing output</h3>
        <p className="text-gray-600 mt-2 text-sm">
          The following files already exist and will be replaced. Back them up before continuing if needed.
        </p>

        <ul className="mt-4 space-y-2">
          {existingFiles.map(file => (
            <li key={file.name} className="flex items-start justify-between gap-2 bg-gray-50 rounded p-2">
              <div className="min-w-0">
                <p className="text-gray-900 text-xs font-mono truncate">{file.name}</p>
                <p className="text-gray-400 text-xs truncate">{file.relative_path}</p>
              </div>
              <button
                onClick={() => handleOpen(file.relative_path)}
                className="shrink-0 text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
              >
                📂 Open in Explorer
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-500"
          >
            Continue (overwrite)
          </button>
        </div>
      </div>
    </div>
  )
}
