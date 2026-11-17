import { useCallback, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { uploadDocument, finalizeDocuments } from '../../api'

function isMultiSheetSpreadsheet(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  return ext === 'xls' || ext === 'xlsx' || ext === 'numbers'
}

const Spinner = () => (
  <svg className="animate-spin h-5 w-5 text-indigo-500 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
  </svg>
)

export default function FileUploader({ projectId, onUpload, onFileUploaded }) {
  const [uploading, setUploading] = useState(false)
  const [status, setStatus]     = useState('')
  const [folderMode, setFolderMode] = useState(false)
  const folderInputRef = useRef(null)

  const [pendingFiles, setPendingFiles]       = useState(null)
  const [showExcelWarning, setShowExcelWarning] = useState(false)

  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({
    current: 0, total: 0, fileName: '',
    succeeded: 0, failed: 0, done: false, docCount: null,
  })

  const showModal = scanning || uploading || progress.done

  async function uploadFiles(files, folderName = null) {
    const isBatch = files.length > 1

    setUploading(true)
    setScanning(false)
    setProgress({ current: 0, total: files.length, fileName: '', succeeded: 0, failed: 0, done: false, docCount: null })

    let succeeded = 0
    let failed = 0

    for (let i = 0; i < files.length; i++) {
      setProgress(p => ({ ...p, current: i + 1, fileName: files[i].name }))
      try {
        await uploadDocument(projectId, files[i], folderName, isBatch)
        succeeded++
        // Only fire live reload for single-file uploads; batches finalize at the end
        if (!isBatch && onFileUploaded) onFileUploaded()
      } catch (err) {
        failed++
      }
    }

    // One inventory rebuild + one git commit for the whole batch
    let docCount = null
    if (isBatch) {
      try {
        const res = await finalizeDocuments(projectId, succeeded)
        docCount = res.data.document_count
      } catch (err) {
        console.error('[QUAILS] Finalize failed:', err)
      }
    }

    setUploading(false)
    setProgress(p => ({ ...p, done: true, succeeded, failed, docCount }))
    setStatus('')
  }

  function maybeWarnExcel(files, folderName = null) {
    if (files.some(f => isMultiSheetSpreadsheet(f.name))) {
      setScanning(false)
      setPendingFiles({ files, folderName })
      setShowExcelWarning(true)
    } else {
      uploadFiles(files, folderName)
    }
  }

  function handleWarningContinue() {
    setShowExcelWarning(false)
    uploadFiles(pendingFiles.files, pendingFiles.folderName)
    setPendingFiles(null)
  }

  function handleWarningCancel() {
    setShowExcelWarning(false)
    setScanning(false)
    setPendingFiles(null)
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  const onDrop = useCallback((acceptedFiles) => {
    maybeWarnExcel(acceptedFiles)
  }, [projectId])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/plain': ['.txt', '.md'],
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.apple.numbers': ['.numbers'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/msword': ['.doc'],
      'application/pdf': ['.pdf'],
      'text/html': ['.html', '.htm'],
    },
  })

  function handleChooseFolder() {
    setScanning(true)
    folderInputRef.current?.click()
  }

  function handleFolderSelect(e) {
    const files = Array.from(e.target.files)
    if (files.length === 0) {
      setScanning(false)
      return
    }
    const folderName = files[0].webkitRelativePath.split('/')[0]
    maybeWarnExcel(files, folderName)
  }

  function handleDone() {
    setProgress({ current: 0, total: 0, fileName: '', succeeded: 0, failed: 0, done: false, docCount: null })
    setScanning(false)
    if (onFileUploaded) onFileUploaded()
    if (onUpload) onUpload()
  }

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div>
      <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={folderMode}
          onChange={(e) => setFolderMode(e.target.checked)}
          className="rounded border-gray-300 bg-gray-50 text-indigo-600 focus:ring-indigo-500"
        />
        <span className="text-xs text-gray-600">Upload as a folder collection</span>
      </label>

      {folderMode ? (
        <div>
          <input
            type="file"
            ref={folderInputRef}
            webkitdirectory="true"
            multiple
            className="hidden"
            onChange={handleFolderSelect}
          />
          <button
            onClick={handleChooseFolder}
            disabled={uploading || scanning}
            className="w-full px-3 py-2 text-sm bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-gray-400 hover:text-gray-800 disabled:opacity-50 transition-colors"
          >
            Choose Folder
          </button>
        </div>
      ) : (
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
            isDragActive ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <input {...getInputProps()} />
          {isDragActive ? (
            <p className="text-indigo-600 text-sm">Drop files here</p>
          ) : (
            <p className="text-gray-500 text-sm">Drag & drop files here, or click to browse</p>
          )}
          <p className="text-gray-400 text-xs mt-1">txt, md, csv, xlsx, xls, numbers, docx, doc, pdf, html</p>
        </div>
      )}

      {/* Inline spinner — only for single-file drag-drop (modal covers batch) */}
      {!showModal && uploading && (
        <div className="mt-3 space-y-1">
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-xs font-medium text-indigo-600">Adding Document...</span>
          </div>
          {status && <p className="text-xs text-gray-500 pl-6">{status}</p>}
        </div>
      )}
      {!showModal && !uploading && status && (
        <p className="text-xs mt-2 text-emerald-700">{status}</p>
      )}

      {/* ── Upload Progress Modal ─────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">

            {/* Phase 1 — Scanning (folder selected, browser enumerating files) */}
            {scanning && !uploading && !progress.done && (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <Spinner />
                  <h3 className="font-semibold text-gray-900 text-sm">Scanning Folder</h3>
                </div>
                <p className="text-sm text-gray-500">Reading folder contents, please wait&hellip;</p>
              </>
            )}

            {/* Phase 2 — Uploading */}
            {uploading && (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <Spinner />
                  <h3 className="font-semibold text-gray-900 text-sm">Uploading Documents</h3>
                </div>

                {progress.total > 0 && (
                  <>
                    <p className="text-xs text-gray-500 mb-2 truncate" title={progress.fileName}>
                      {progress.fileName}
                    </p>
                    <div className="w-full bg-gray-100 rounded-full h-2 mb-1 overflow-hidden">
                      <div
                        className="bg-indigo-500 h-2 rounded-full transition-all duration-200"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>{progress.current.toLocaleString()} of {progress.total.toLocaleString()} files</span>
                      <span>{pct}%</span>
                    </div>
                  </>
                )}

                {progress.failed > 0 && (
                  <p className="text-xs text-amber-600 mt-2">
                    {progress.failed} error{progress.failed !== 1 ? 's' : ''} so far
                  </p>
                )}
              </>
            )}

            {/* Phase 3 — Complete */}
            {progress.done && (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-6 w-6 shrink-0 rounded-full bg-emerald-100 flex items-center justify-center">
                    <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="font-semibold text-gray-900 text-sm">Upload Complete</h3>
                </div>

                <div className="space-y-1 mb-4">
                  <p className="text-sm text-gray-700">
                    <span className="font-medium text-emerald-700">
                      {progress.succeeded.toLocaleString()}
                    </span>{' '}
                    file{progress.succeeded !== 1 ? 's' : ''} uploaded successfully
                  </p>
                  {progress.failed > 0 && (
                    <p className="text-sm text-amber-600">
                      {progress.failed.toLocaleString()} file{progress.failed !== 1 ? 's' : ''} failed
                    </p>
                  )}
                  {progress.docCount !== null && (
                    <p className="text-xs text-gray-400 pt-2 border-t border-gray-100 mt-2">
                      Project now contains{' '}
                      <span className="font-medium text-gray-600">
                        {progress.docCount.toLocaleString()}
                      </span>{' '}
                      document{progress.docCount !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>

                <button
                  onClick={handleDone}
                  className="w-full px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Spreadsheet Warning Modal ─────────────────────────────────── */}
      {showExcelWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-amber-300 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-amber-500 text-xl leading-none">&#9888;</span>
              <h3 className="text-gray-900 font-semibold text-base">Spreadsheet File Warning</h3>
            </div>
            <p className="text-gray-700 text-sm mb-2">
              You are uploading a spreadsheet file (<code className="text-amber-700 font-mono">.xls</code>,{' '}
              <code className="text-amber-700 font-mono">.xlsx</code>, or{' '}
              <code className="text-amber-700 font-mono">.numbers</code>).
            </p>
            <p className="text-gray-700 text-sm mb-2">
              <strong>Multi-sheet workbooks will likely render improperly.</strong> Only the first sheet
              (and, for Numbers documents, only the first table on that sheet) will be read — data
              elsewhere in the file will be ignored.
            </p>
            <p className="text-gray-700 text-sm mb-4">
              It is strongly recommended to use <strong>single-sheet, single-table documents</strong> only.
              Consider exporting each sheet/table as a separate file before uploading.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleWarningCancel}
                className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleWarningContinue}
                className="px-4 py-2 text-sm bg-amber-500 text-white rounded hover:bg-amber-600"
              >
                Upload Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
