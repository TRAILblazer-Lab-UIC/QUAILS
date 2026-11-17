// Save a Blob (from an axios responseType:'blob' call) as a downloaded file.
export function saveBlob(data, filename) {
  const url = window.URL.createObjectURL(new Blob([data]))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
}

// Test timestamps written before 2026-10 carry a doubled timezone ("…+00:00Z"),
// which Date() cannot parse; normalise before formatting.
export function formatTimestamp(value, fallback = '—') {
  if (!value) return fallback
  const d = new Date(String(value).replace(/([+-]\d\d:\d\d)Z$/, '$1'))
  return isNaN(d) ? fallback : d.toLocaleString()
}
