import { useState } from 'react'

export default function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  requireTyped = false,
  confirmWord = 'DELETE',
}) {
  const [typed, setTyped] = useState('')

  const confirmed = !requireTyped || typed === confirmWord

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-gray-900 font-semibold text-lg">{title}</h3>
        <p className="text-gray-600 mt-2">{message}</p>
        {requireTyped && (
          <>
            <p className="text-gray-600 mt-3 text-sm">
              Type <strong className="text-red-600">{confirmWord}</strong> to confirm:
            </p>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full mt-2 px-3 py-2 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-red-500"
              placeholder={`Type ${confirmWord} to confirm`}
              autoFocus
            />
          </>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
