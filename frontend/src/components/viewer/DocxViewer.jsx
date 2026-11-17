import { useState, useEffect } from 'react'
import mammoth from 'mammoth'

export default function DocxViewer({ projectId, filename }) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    loadDocx()
  }, [projectId, filename])

  async function loadDocx() {
    try {
      const url = `/api/documents/${projectId}/serve/${filename}`
      const response = await fetch(url)
      const arrayBuffer = await response.arrayBuffer()
      const result = await mammoth.convertToHtml({ arrayBuffer })
      setHtml(result.value)
    } catch (err) {
      setError('Failed to load document: ' + err.message)
    }
  }

  if (error) return <div className="text-red-600 p-4">{error}</div>

  return (
    <div
      className="prose max-w-none p-4 bg-white rounded-lg"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
