import { useState, useEffect, useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community'
import ConfidenceRenderer from './ConfidenceRenderer'
import ColumnVisibilityPanel from './ColumnVisibilityPanel'
import UnitPreviewPopup from './UnitPreviewPopup'
import { getCsvData, editCsvRow } from '../../api'

ModuleRegistry.registerModules([AllCommunityModule])

export default function CsvBrowser({ projectId, onUnitClick, pendingDataFile }) {
  const [previewUnitId, setPreviewUnitId] = useState(null)
  const [blockId, setBlockId] = useState('')
  const [filename, setFilename] = useState('')
  const [rowData, setRowData] = useState([])
  const [colDefs, setColDefs] = useState([])
  const [hiddenCols, setHiddenCols] = useState(new Set())
  const [showColPanel, setShowColPanel] = useState(false)
  const [loadPath, setLoadPath] = useState('')

  function buildColDefs(columns, currentHidden) {
    return columns.map(col => {
      const def = {
        field: col,
        headerName: col,
        sortable: true,
        filter: true,
        resizable: true,
        hide: currentHidden.has(col),
      }
      if (col.includes('confidence')) {
        def.cellRenderer = ConfidenceRenderer
        def.width = 140
      }
      if (col === 'unit_id') {
        def.cellStyle = { cursor: 'pointer', color: '#4f46e5' }
        def.onCellClicked = (params) => {
          setPreviewUnitId(params.value)
        }
      }
      if (['label', 'reasoning'].includes(col)) {
        def.editable = true
      }
      return def
    })
  }

  async function loadCsv() {
    if (!blockId || !filename) return
    try {
      const res = await getCsvData(projectId, blockId, filename)
      const { columns, rows } = res.data
      setColDefs(buildColDefs(columns, hiddenCols))
      setRowData(rows)
    } catch (err) {
      console.error('Failed to load CSV:', err)
    }
  }

  // Auto-load when the parent navigates here with a specific file
  useEffect(() => {
    if (!pendingDataFile) return
    const { blockId: bid, filename: fname } = pendingDataFile
    setBlockId(bid)
    setFilename(fname)
    if (!bid || !fname) return
    const emptyHidden = new Set()
    setHiddenCols(emptyHidden)
    getCsvData(projectId, bid, fname)
      .then(res => {
        const { columns, rows } = res.data
        setColDefs(buildColDefs(columns, emptyHidden))
        setRowData(rows)
      })
      .catch(err => console.error('Failed to load CSV:', err))
  }, [pendingDataFile, projectId])

  async function onCellValueChanged(event) {
    const rowIndex = event.rowIndex
    const field = event.colDef.field
    try {
      await editCsvRow(projectId, blockId, filename, rowIndex, { [field]: event.newValue })
    } catch (err) {
      console.error('Failed to save edit:', err)
    }
  }

  function toggleColumn(colName) {
    const newHidden = new Set(hiddenCols)
    if (newHidden.has(colName)) {
      newHidden.delete(colName)
    } else {
      newHidden.add(colName)
    }
    setHiddenCols(newHidden)
    setColDefs(prev => prev.map(d => ({
      ...d,
      hide: newHidden.has(d.field),
    })))
  }

  const defaultColDef = useMemo(() => ({
    flex: 1,
    minWidth: 100,
  }), [])

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex gap-2 mb-4 items-end">
        <label className="block">
          <span className="text-gray-600 text-xs">Block ID</span>
          <input
            value={blockId}
            onChange={(e) => setBlockId(e.target.value)}
            className="block mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
            placeholder="e.g., sourceAnalysis_0"
          />
        </label>
        <label className="block">
          <span className="text-gray-600 text-xs">Filename</span>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            className="block mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900"
            placeholder="e.g., sourceAnalysis_0_labels.csv"
          />
        </label>
        <button
          onClick={loadCsv}
          className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500"
        >
          Load
        </button>
        <button
          onClick={() => setShowColPanel(!showColPanel)}
          className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          Columns
        </button>
      </div>

      {showColPanel && (
        <ColumnVisibilityPanel
          columns={colDefs.map(d => d.field)}
          hidden={hiddenCols}
          onToggle={toggleColumn}
        />
      )}

      <div className="flex-1 ag-theme-alpine">
        <AgGridReact
          rowData={rowData}
          columnDefs={colDefs}
          defaultColDef={defaultColDef}
          onCellValueChanged={onCellValueChanged}
          animateRows={true}
          rowSelection="single"
        />
      </div>

      {previewUnitId && (
        <UnitPreviewPopup
          projectId={projectId}
          unitId={previewUnitId}
          onClose={() => setPreviewUnitId(null)}
          onOpenInViewer={(unitId) => {
            setPreviewUnitId(null)
            if (onUnitClick) onUnitClick(unitId)
          }}
        />
      )}
    </div>
  )
}
