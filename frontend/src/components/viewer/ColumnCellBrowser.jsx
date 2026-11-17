import { useState, useEffect } from 'react'
import { reparseColumn, resetColumnGranularity } from '../../api'
import ConfirmDialog from '../common/ConfirmDialog'
import DelimiterListInput from '../common/DelimiterListInput'

// Old saved granularity entries may carry a single `delimiter` string
// instead of the `delimiters` array — normalize on read.
function granularityDelimiters(granularity) {
  if (!granularity) return []
  if (granularity.delimiters) return granularity.delimiters
  return granularity.delimiter ? [granularity.delimiter] : []
}

function describeMethod(method, delimiters) {
  const delimList = delimiters.map(d => `"${d}"`).join(', ')
  if (method === 'both') return `sentence boundaries + delimiters ${delimList}`
  if (method === 'delimiter') return `delimiters ${delimList}`
  return 'sentence boundaries'
}

export default function ColumnCellBrowser({ projectId, docIndex, parsedData, columnName, onReparsed }) {
  const granularity = parsedData?.column_granularity?.[columnName]

  const [method, setMethod] = useState(granularity?.method || 'sentence')
  const [delimiters, setDelimiters] = useState(granularityDelimiters(granularity))
  const [showReparseConfirm, setShowReparseConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setMethod(granularity?.method || 'sentence')
    setDelimiters(granularityDelimiters(granularity))
    setShowReparseConfirm(false)
    setShowResetConfirm(false)
    setError(null)
  }, [columnName])

  const units = parsedData?.units || []
  const rowUnits = units.filter(u => u.unit_type === 'L' && u.row_data && u.row_data[columnName])

  const subUnitsByParent = {}
  for (const u of units) {
    if (u.unit_type === 'R' && u.column_name === columnName) {
      subUnitsByParent[u.parent_unit_id] = subUnitsByParent[u.parent_unit_id] || []
      subUnitsByParent[u.parent_unit_id].push(u)
    }
  }
  Object.values(subUnitsByParent).forEach(list => list.sort((a, b) => (a.sent_index ?? 0) - (b.sent_index ?? 0)))

  async function handleReparse() {
    setIsLoading(true)
    setError(null)
    try {
      await reparseColumn(projectId, docIndex, columnName, method, method !== 'sentence' ? delimiters : null)
      setShowReparseConfirm(false)
      onReparsed?.()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to re-parse column')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleReset() {
    setIsLoading(true)
    setError(null)
    try {
      await resetColumnGranularity(projectId, docIndex, columnName)
      setShowResetConfirm(false)
      onReparsed?.()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset column')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-gray-900 font-semibold text-sm">Column: {columnName}</h3>
          {granularity ? (
            <span className="text-xs text-emerald-700 bg-emerald-100 border border-emerald-200 rounded px-2 py-0.5">
              ✓ Split into {granularity.sub_unit_count} sub-unit{granularity.sub_unit_count === 1 ? '' : 's'}
              {' '}({describeMethod(granularity.method, granularityDelimiters(granularity))})
            </span>
          ) : (
            <span className="text-xs text-gray-500">Not yet split — whole-cell only</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="cell_browser_method" checked={method === 'sentence'} onChange={() => setMethod('sentence')} />
            <span className="text-xs text-gray-700">Sentence boundaries</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="cell_browser_method" checked={method === 'delimiter'} onChange={() => setMethod('delimiter')} />
            <span className="text-xs text-gray-700">Custom delimiter</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="cell_browser_method" checked={method === 'both'} onChange={() => setMethod('both')} />
            <span className="text-xs text-gray-700">Both sentence boundaries and delimiters</span>
          </label>
        </div>
        {(method === 'delimiter' || method === 'both') && (
          <div className="mt-2 max-w-xs">
            <DelimiterListInput delimiters={delimiters} onChange={setDelimiters} />
          </div>
        )}

        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => setShowReparseConfirm(true)}
            disabled={isLoading || (method !== 'sentence' && delimiters.length === 0)}
            className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Working…' : 'Re-parse Column'}
          </button>
          {granularity && (
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={isLoading}
              className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-600 hover:text-white transition-colors disabled:opacity-40"
            >
              Reset to Whole Cell
            </button>
          )}
        </div>
        {error && (
          <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>
        )}
      </div>

      <div className="space-y-2">
        {rowUnits.map(rowUnit => {
          const subUnits = subUnitsByParent[rowUnit.unit_id] || []
          return (
            <div key={rowUnit.unit_id} className="border border-gray-200 rounded-lg p-3">
              <div className="font-mono text-[10px] text-gray-400">{rowUnit.unit_id}</div>
              <div className="text-sm text-gray-800 mt-1">{rowUnit.row_data[columnName]}</div>
              {subUnits.length > 0 ? (
                <div className="mt-2 pl-3 border-l-2 border-indigo-200 space-y-1">
                  {subUnits.map(sub => (
                    <div key={sub.unit_id} className="text-xs">
                      <span className="font-mono text-[10px] text-indigo-400 mr-2">{sub.unit_id}</span>
                      <span className="text-gray-700">{sub.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-gray-400 italic">Not yet split</p>
              )}
            </div>
          )
        })}
        {rowUnits.length === 0 && (
          <p className="text-center text-gray-400 text-sm py-8">No rows have a value in this column.</p>
        )}
      </div>

      {showReparseConfirm && (
        <ConfirmDialog
          title="Re-parse Column"
          message={`This will ${granularity ? 're-generate' : 'generate'} sentence-level sub-units for "${columnName}" across all rows, using ${describeMethod(method, delimiters)}. ${granularity ? 'Any previously generated sub-units for this column will be replaced.' : ''} This is saved permanently and does not affect other columns or the original row data.`}
          onConfirm={handleReparse}
          onCancel={() => setShowReparseConfirm(false)}
        />
      )}

      {showResetConfirm && (
        <ConfirmDialog
          title="Reset Column to Whole Cell"
          message={`This will permanently remove the ${granularity?.sub_unit_count ?? ''} sentence-level sub-unit(s) generated for "${columnName}". The row data itself is untouched.`}
          requireTyped
          confirmWord="reset"
          onConfirm={handleReset}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  )
}
