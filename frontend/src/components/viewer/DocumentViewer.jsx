import { useState, useEffect, useRef } from 'react'
import { listDocuments, listFolders, getParsedDoc, deleteDocument, deleteFolder } from '../../api'
import PdfViewer from './PdfViewer'
import DocxViewer from './DocxViewer'
import TextViewer from './TextViewer'
import ColumnCellBrowser from './ColumnCellBrowser'
import ConfirmDialog from '../common/ConfirmDialog'

const TABULAR_FORMATS = new Set(['csv', 'xlsx', 'xls', 'numbers'])

const FOLDER_PAGE_SIZE = 25

export default function DocumentViewer({ projectId, selectedUnit, refreshKey }) {
  const [documents, setDocuments] = useState([])
  const [folders, setFolders] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [parsedData, setParsedData] = useState(null)
  const [selectedFolder, setSelectedFolder] = useState(null)
  const [folderPage, setFolderPage] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [hoveredUnitId, setHoveredUnitId] = useState(null)
  const [highlightMode, setHighlightMode] = useState('paragraph')
  const [selectedColumn, setSelectedColumn] = useState(null)
  const unitsPanelRef = useRef(null)
  const centerScrollRef = useRef(null)
  const [scrollHint, setScrollHint] = useState({ left: false, right: false })

  function updateScrollHint() {
    const el = centerScrollRef.current
    if (!el) return
    setScrollHint({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
  }

  // Track whether the center panel has more content off-screen horizontally
  // (e.g. a wide spreadsheet table) so a scroll-right/left hint can be shown —
  // the panel scrolls internally rather than the whole page.
  useEffect(() => {
    const el = centerScrollRef.current
    if (!el) return
    updateScrollHint()
    const ro = new ResizeObserver(updateScrollHint)
    ro.observe(el)
    el.addEventListener('scroll', updateScrollHint, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', updateScrollHint)
    }
  }, [])

  useEffect(() => {
    updateScrollHint()
  }, [parsedData, selectedColumn, selectedFolder, folderPage])

  useEffect(() => {
    loadDocuments()
  }, [projectId, refreshKey])

  useEffect(() => {
    if (selectedUnit && documents.length > 0) {
      const parts = selectedUnit.split('-')
      if (parts.length >= 2) {
        const docIndex = parseInt(parts[1])
        const doc = documents.find(d => d.doc_index === docIndex)
        if (doc) {
          setSelectedDoc(doc)
          setSelectedFolder(null)
          setSelectedColumn(null)
          loadParsed(docIndex)
        }
      }
    }
  }, [selectedUnit, documents])

  // Auto-scroll units panel to selected unit
  useEffect(() => {
    if (selectedUnit && unitsPanelRef.current) {
      const el = unitsPanelRef.current.querySelector(`[data-unit-id="${selectedUnit}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [selectedUnit, parsedData])

  async function loadDocuments() {
    try {
      const [docsRes, foldersRes] = await Promise.all([
        listDocuments(projectId),
        listFolders(projectId),
      ])
      setDocuments(docsRes.data)
      setFolders(foldersRes.data.folders || [])
    } catch (err) {
      console.error('Failed to load documents:', err)
    }
  }

  async function loadParsed(docIndex) {
    try {
      const res = await getParsedDoc(projectId, docIndex)
      setParsedData(res.data)
    } catch (err) {
      console.error('Failed to load parsed doc:', err)
    }
  }

  function handleDocSelect(doc) {
    setSelectedDoc(doc)
    setSelectedFolder(null)
    setSelectedColumn(null)
    loadParsed(doc.doc_index)
  }

  function handleFolderSelect(folder) {
    setSelectedFolder(folder)
    setSelectedDoc(null)
    setParsedData(null)
    setSelectedColumn(null)
    setFolderPage(0)
  }

  async function handleDeleteDoc() {
    if (!deleteTarget) return
    try {
      await deleteDocument(projectId, deleteTarget.doc_index)
      setDeleteTarget(null)
      if (selectedDoc?.doc_index === deleteTarget.doc_index) {
        setSelectedDoc(null)
        setParsedData(null)
      }
      loadDocuments()
    } catch (err) {
      console.error('Failed to delete document:', err)
    }
  }

  async function handleDeleteFolder() {
    if (!deleteFolderTarget) return
    try {
      await deleteFolder(projectId, deleteFolderTarget.folder_name)
      setDeleteFolderTarget(null)
      if (selectedFolder?.folder_name === deleteFolderTarget.folder_name) {
        setSelectedFolder(null)
        setSelectedDoc(null)
        setParsedData(null)
      }
      loadDocuments()
    } catch (err) {
      console.error('Failed to delete folder:', err)
    }
  }

  const query = searchQuery.toLowerCase()

  function applySortDir(arr, key) {
    return [...arr].sort((a, b) =>
      sortDir === 'asc'
        ? a[key].localeCompare(b[key])
        : b[key].localeCompare(a[key])
    )
  }

  const standaloneDocs = applySortDir(
    documents.filter(d => !d.folder_name && (!query || d.filename.toLowerCase().includes(query))),
    'filename'
  )
  const filteredFolders = applySortDir(
    folders.filter(f => !query || f.folder_name.toLowerCase().includes(query)),
    'folder_name'
  )

  // Docs in current folder view
  const folderDocs = selectedFolder
    ? applySortDir(
        documents.filter(d => selectedFolder.doc_indices.includes(d.doc_index)),
        'filename'
      )
    : []
  const folderPageCount = Math.ceil(folderDocs.length / FOLDER_PAGE_SIZE)
  const folderPageDocs = folderDocs.slice(
    folderPage * FOLDER_PAGE_SIZE,
    (folderPage + 1) * FOLDER_PAGE_SIZE
  )

  const ext = selectedDoc?.filename?.split('.').pop().toLowerCase()
  const isTabular = !!(parsedData?.format && TABULAR_FORMATS.has(parsedData.format) && parsedData.columns?.length)

  return (
    <div className="h-full flex">
      {/* Document list */}
      <div className="w-52 border-r border-gray-200 overflow-y-auto flex flex-col">
        <div className="p-3 pb-0">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900 placeholder-gray-400 mb-2"
          />
          <button
            onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
            className="w-full flex items-center justify-between px-2 py-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded hover:bg-gray-100 transition-colors mb-3"
            title="Toggle sort order"
          >
            <span>Sort: {sortDir === 'asc' ? 'A → Z' : 'Z → A'}</span>
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {sortDir === 'asc' ? (
                <>
                  <path d="M2 3h5M2 6h3.5M2 9h2" />
                  <path d="M9 2v8M7 8l2 2 2-2" />
                </>
              ) : (
                <>
                  <path d="M2 3h2M2 6h3.5M2 9h5" />
                  <path d="M9 10V2M7 4l2-2 2 2" />
                </>
              )}
            </svg>
          </button>
        </div>
        <div className="p-3 pt-0 flex-1">
          {folders.length === 0 && documents.length === 0 ? (
            <p className="text-gray-400 text-xs">No documents uploaded</p>
          ) : (
            <div className="space-y-1">
              {/* Folders */}
              {filteredFolders.map(folder => (
                <div
                  key={folder.folder_name}
                  className={`group w-full text-left px-2 py-1.5 text-xs rounded transition-colors cursor-pointer ${
                    selectedFolder?.folder_name === folder.folder_name
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                  onClick={() => handleFolderSelect(folder)}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <span>&#128193;</span>
                      <span className="truncate font-medium">{folder.folder_name}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteFolderTarget(folder) }}
                      title="Delete folder collection"
                      className="shrink-0 opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center rounded-full bg-red-100 text-red-600 hover:bg-red-600 hover:text-white transition-all"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="currentColor" className="w-2 h-2">
                        <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06Z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="text-gray-400 pl-5">{folder.doc_indices.length} docs</div>
                </div>
              ))}
              {/* Standalone docs */}
              {standaloneDocs.map(doc => (
                <div
                  key={doc.doc_index}
                  onClick={() => handleDocSelect(doc)}
                  className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors cursor-pointer ${
                    selectedDoc?.doc_index === doc.doc_index
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{doc.filename}</span>
                    {selectedDoc?.doc_index === doc.doc_index && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(doc) }}
                        title="Delete document"
                        className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full bg-red-100 text-red-600 hover:bg-red-600 hover:text-white transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="currentColor" className="w-2 h-2">
                          <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06Z"/>
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="text-gray-400">{doc.unit_count} units</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Center panel */}
      <div className="flex-1 min-w-0 relative">
        <div ref={centerScrollRef} className="absolute inset-0 overflow-auto">
        {selectedFolder ? (
          /* Folder view */
          <div className="p-4">
            <button
              onClick={() => setSelectedFolder(null)}
              className="text-xs text-indigo-600 hover:text-indigo-800 mb-4 flex items-center gap-1"
            >
              &#8592; All Documents
            </button>
            <h2 className="text-gray-900 font-semibold text-sm mb-3 flex items-center gap-2">
              <span>&#128193;</span>
              {selectedFolder.folder_name}
              <span className="text-gray-400 font-normal">({folderDocs.length} docs)</span>
            </h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
                  <th className="text-left py-1.5 pr-4">Filename</th>
                  <th className="text-right py-1.5">Units</th>
                </tr>
              </thead>
              <tbody>
                {folderPageDocs.map(doc => (
                  <tr
                    key={doc.doc_index}
                    onClick={() => handleDocSelect(doc)}
                    className="border-b border-gray-100 cursor-pointer hover:bg-indigo-50 transition-colors"
                  >
                    <td className="py-1.5 pr-4 text-indigo-700 hover:underline truncate max-w-xs">{doc.filename}</td>
                    <td className="py-1.5 text-right text-gray-500">{doc.unit_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {folderPageCount > 1 && (
              <div className="flex items-center justify-center gap-3 mt-4 text-xs text-gray-600">
                <button
                  onClick={() => setFolderPage(p => Math.max(0, p - 1))}
                  disabled={folderPage === 0}
                  className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span>Page {folderPage + 1} of {folderPageCount}</span>
                <button
                  onClick={() => setFolderPage(p => Math.min(folderPageCount - 1, p + 1))}
                  disabled={folderPage >= folderPageCount - 1}
                  className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        ) : !selectedDoc ? (
          <div className="text-center text-gray-400 py-12">
            Select a document to view
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Doc header — spreadsheet column selector / highlight mode kept leftmost so it's
                reachable without scrolling right, even on a narrow window; filename shrinks first. */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
              {isTabular ? (
                <>
                  <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">
                    Select a specific row to parse &#8594;
                  </span>
                  <select
                    value={selectedColumn || ''}
                    onChange={e => setSelectedColumn(e.target.value || null)}
                    className="shrink-0 w-40 px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-700"
                    title="Browse a column's cells"
                  >
                    <option value="">All rows view (default)</option>
                    {parsedData.columns.map(col => (
                      <option key={col} value={col}>
                        {col}{parsedData.column_granularity?.[col] ? ' — ✓ reparsed' : ''}
                      </option>
                    ))}
                  </select>
                </>
              ) : ext !== 'pdf' && ext !== 'docx' && (
                <select
                  value={highlightMode}
                  onChange={e => setHighlightMode(e.target.value)}
                  className="shrink-0 w-40 px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-700"
                  title="Hover highlight mode"
                >
                  <option value="none">No highlight</option>
                  <option value="paragraph">Highlight paragraph</option>
                  <option value="section">Highlight section</option>
                </select>
              )}
              <span className="text-xs text-gray-600 truncate flex-1 min-w-0">{selectedDoc.filename}</span>
              <button
                onClick={() => setDeleteTarget(selectedDoc)}
                className="shrink-0 px-2 py-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-600 hover:text-white hover:border-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
            {/* Viewer */}
            <div className="flex-1 overflow-auto p-4">
              {ext === 'pdf' ? (
                <PdfViewer projectId={projectId} filename={selectedDoc.filename} />
              ) : ext === 'docx' ? (
                <DocxViewer projectId={projectId} filename={selectedDoc.filename} />
              ) : isTabular && selectedColumn ? (
                <ColumnCellBrowser
                  projectId={projectId}
                  docIndex={selectedDoc.doc_index}
                  parsedData={parsedData}
                  columnName={selectedColumn}
                  onReparsed={() => loadParsed(selectedDoc.doc_index)}
                />
              ) : (
                <TextViewer
                  parsedData={parsedData}
                  selectedUnit={selectedUnit}
                  hoveredUnitId={hoveredUnitId}
                  onHoverUnit={setHoveredUnitId}
                  highlightMode={highlightMode}
                />
              )}
            </div>
          </div>
        )}
        </div>
      {scrollHint.left && (
        <div className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-8 bg-gradient-to-r from-white/95 to-transparent flex items-center">
          <span className="pl-0.5 text-indigo-400 text-sm">&#8592;</span>
        </div>
      )}
      {scrollHint.right && (
        <div className="pointer-events-none absolute top-0 bottom-0 right-0 z-10 w-8 bg-gradient-to-l from-white/95 to-transparent flex items-center justify-end">
          <span className="pr-0.5 text-indigo-400 text-sm animate-pulse">&#8594;</span>
        </div>
      )}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Document"
          message={`Are you sure you want to delete "${deleteTarget.filename}"? This will permanently remove the file and all its parsed units.`}
          onConfirm={handleDeleteDoc}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {deleteFolderTarget && (
        <ConfirmDialog
          title="Delete Folder Collection"
          message={`This will permanently delete the folder "${deleteFolderTarget.folder_name}" and all ${deleteFolderTarget.doc_indices.length} document${deleteFolderTarget.doc_indices.length !== 1 ? 's' : ''} inside it. This cannot be undone.`}
          requireTyped
          confirmWord="delete"
          onConfirm={handleDeleteFolder}
          onCancel={() => setDeleteFolderTarget(null)}
        />
      )}

      {/* Units panel */}
      {parsedData && selectedDoc && (
        <div ref={unitsPanelRef} className="w-64 border-l border-gray-200 overflow-y-auto">
          <div className="p-3">
            <p className="text-gray-500 text-xs font-semibold uppercase mb-2">Units</p>
            <div className="space-y-1">
              {parsedData.units?.filter(u => !u.is_header && u.unit_type !== 'R').map(unit => (
                <div
                  key={unit.unit_id}
                  data-unit-id={unit.unit_id}
                  onMouseEnter={() => setHoveredUnitId(unit.unit_id)}
                  onMouseLeave={() => setHoveredUnitId(null)}
                  className={`px-2 py-1.5 text-xs rounded cursor-pointer ${
                    selectedUnit === unit.unit_id
                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                      : hoveredUnitId === unit.unit_id
                      ? 'bg-gray-100 text-gray-800'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <div className="font-mono text-[10px] text-gray-400">{unit.unit_id}</div>
                  <div className="truncate mt-0.5">{unit.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
