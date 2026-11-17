import { useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

export default function PdfViewer({ projectId, filename }) {
  const [numPages, setNumPages] = useState(null)
  const [pageNumber, setPageNumber] = useState(1)
  const url = `/api/documents/${projectId}/serve/${filename}`

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
          disabled={pageNumber <= 1}
          className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded disabled:opacity-50"
        >
          Prev
        </button>
        <span className="text-gray-600 text-sm">
          Page {pageNumber} of {numPages || '?'}
        </span>
        <button
          onClick={() => setPageNumber(Math.min(numPages || 1, pageNumber + 1))}
          disabled={pageNumber >= (numPages || 1)}
          className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>

      <Document
        file={url}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        className="flex justify-center"
      >
        <Page pageNumber={pageNumber} width={700} />
      </Document>
    </div>
  )
}
