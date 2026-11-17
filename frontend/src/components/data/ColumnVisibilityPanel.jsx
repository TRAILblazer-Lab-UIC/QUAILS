export default function ColumnVisibilityPanel({ columns, hidden, onToggle }) {
  return (
    <div className="mb-3 p-3 bg-white border border-gray-200 rounded-lg">
      <p className="text-gray-500 text-xs font-semibold mb-2">Toggle Columns</p>
      <div className="flex flex-wrap gap-2">
        {columns.map(col => (
          <button
            key={col}
            onClick={() => onToggle(col)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              hidden.has(col)
                ? 'bg-gray-100 text-gray-400'
                : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
            }`}
          >
            {col}
          </button>
        ))}
      </div>
    </div>
  )
}
