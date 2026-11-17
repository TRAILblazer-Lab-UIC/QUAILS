import { useState } from 'react'

/**
 * Editable list of delimiter strings, rendered as removable chips plus an
 * add-one-at-a-time text input. Used wherever a cell/column can be split on
 * more than one delimiter (e.g. some rows use "." and others use ";").
 */
export default function DelimiterListInput({ delimiters, onChange, placeholder = 'e.g. ; or .', inputClassName = '' }) {
  const [draft, setDraft] = useState('')

  function addDelimiter() {
    const trimmed = draft
    if (!trimmed || delimiters.includes(trimmed)) return
    onChange([...delimiters, trimmed])
    setDraft('')
  }

  function removeDelimiter(d) {
    onChange(delimiters.filter(x => x !== d))
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addDelimiter()
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`flex-1 px-2 py-1 text-xs bg-white border border-gray-300 rounded text-gray-900 ${inputClassName}`}
        />
        <button
          type="button"
          onClick={addDelimiter}
          disabled={!draft || delimiters.includes(draft)}
          className="px-2 py-1 text-xs font-medium bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add Delimiter
        </button>
      </div>
      {delimiters.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {delimiters.map(d => (
            <span
              key={d}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono bg-indigo-50 border border-indigo-200 text-indigo-700 rounded"
            >
              "{d}"
              <button
                type="button"
                onClick={() => removeDelimiter(d)}
                className="text-indigo-400 hover:text-indigo-700 leading-none"
                aria-label={`Remove delimiter ${d}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-gray-400">Add one or more delimiters — a cell is split wherever any of them appears.</p>
      )}
    </div>
  )
}
