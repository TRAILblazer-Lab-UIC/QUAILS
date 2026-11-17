import { useState, Fragment } from 'react'
import { getAlignmentTest, deleteAlignmentTest, downloadAlignmentCsv, downloadAlignmentReport } from '../../api'
import { saveBlob, formatTimestamp } from './downloadUtil'
import ReportMenu from './ReportMenu'
import ConfirmDialog from '../common/ConfirmDialog'
import HelpLabel from '../common/HelpLabel'

export default function TestHistory({ projectId, blockId, tests, onTestSelect, onTestDeleted, onRerun }) {
  const [expandedId, setExpandedId] = useState(null)
  const [expandedData, setExpandedData] = useState(null)
  const [deleteId, setDeleteId] = useState(null)

  if (!tests || tests.length === 0) return null

  async function handleExpand(testId) {
    if (expandedId === testId) {
      setExpandedId(null)
      setExpandedData(null)
      return
    }
    try {
      const res = await getAlignmentTest(projectId, testId)
      setExpandedData(res.data)
      setExpandedId(testId)
    } catch (err) {
      console.error('Failed to load test:', err)
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteAlignmentTest(projectId, deleteId)
      setDeleteId(null)
      if (onTestDeleted) onTestDeleted(deleteId)
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  function kappaColor(k) {
    if (k == null) return 'text-gray-400'
    if (k >= 0.81) return 'text-emerald-700'
    if (k >= 0.61) return 'text-green-700'
    if (k >= 0.41) return 'text-amber-700'
    if (k >= 0.21) return 'text-orange-600'
    return 'text-red-600'
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h4 className="text-gray-900 font-medium text-sm mb-3">Test History</h4>

      {deleteId && (
        <ConfirmDialog
          title="Delete Test"
          message={`Are you sure you want to delete test ${deleteId}? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-3 text-gray-500 text-xs font-medium">
                <HelpLabel label="Date" help="When the alignment test was created." />
              </th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">
                <HelpLabel label="% Alignment" help="Percentage of units where human and LLM agree on detection (TRUE/FALSE)." />
              </th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">
                <HelpLabel label="Cohen's Kappa" help="Statistical measure of inter-rater agreement accounting for chance. >0.81 is almost perfect." />
              </th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">
                <HelpLabel label="Overall" help="Weighted average of all metric scores." />
              </th>
              <th className="py-2 px-3 text-gray-500 text-xs font-medium">Status</th>
              <th className="py-2 pl-3 text-gray-500 text-xs font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tests.map(t => (
              <Fragment key={t.test_id}>
                <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => handleExpand(t.test_id)}>
                  <td className="py-1.5 pr-3 text-gray-700 text-xs">
                    {formatTimestamp(t.created_at)}
                  </td>
                  <td className="py-1.5 px-3 text-gray-900">
                    {t.metrics?.detection != null ? `${t.metrics.detection}%` : '—'}
                  </td>
                  <td className={`py-1.5 px-3 font-medium ${kappaColor(t.metrics?.cohens_kappa)}`}>
                    {t.metrics?.cohens_kappa != null ? t.metrics.cohens_kappa.toFixed(4) : '—'}
                  </td>
                  <td className="py-1.5 px-3 text-gray-900">
                    {t.metrics?.overall_score != null ? `${t.metrics.overall_score}%` : '—'}
                  </td>
                  <td className="py-1.5 px-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      t.status === 'complete' ? 'bg-emerald-100 text-emerald-700' :
                      t.status === 'error' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="py-1.5 pl-3">
                    <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                      {t.status === 'complete' && (
                        <button
                          onClick={() => onTestSelect(t.test_id)}
                          className="px-2 py-0.5 text-[10px] bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
                        >
                          View
                        </button>
                      )}
                      <button
                        onClick={() => downloadAlignmentCsv(projectId, t.test_id).then(r => saveBlob(r.data, `${t.test_id}_cases_and_codes.csv`)).catch(err => console.error('CSV download failed:', err))}
                        className="px-2 py-0.5 text-[10px] bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                        title="Download test cases and human codes as CSV"
                      >
                        CSV
                      </button>
                      <ReportMenu
                        fetcher={(fmt) => downloadAlignmentReport(projectId, t.test_id, fmt)}
                        filenameBase={t.test_id}
                        label="Report"
                        className="px-2 py-0.5 text-[10px] bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                      />
                      <button
                        onClick={() => onRerun(t.test_id)}
                        className="px-2 py-0.5 text-[10px] bg-amber-50 text-amber-700 rounded hover:bg-amber-100"
                        title="Re-run with current prompts"
                      >
                        Re-run
                      </button>
                      <button
                        onClick={() => setDeleteId(t.test_id)}
                        className="px-2 py-0.5 text-[10px] bg-red-50 text-red-700 rounded hover:bg-red-100"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedId === t.test_id && expandedData?.prompts_snapshot && (
                  <tr>
                    <td colSpan={6} className="py-2 px-4 bg-gray-50">
                      <div className="text-xs text-gray-600 space-y-1">
                        <div className="font-medium text-gray-700">Prompts used in this test:</div>
                        {expandedData.prompts_snapshot.detection_prompt && (
                          <div><strong>Detection:</strong> {expandedData.prompts_snapshot.detection_prompt}</div>
                        )}
                        {expandedData.prompts_snapshot.label_prompt && (
                          <div><strong>Label:</strong> {expandedData.prompts_snapshot.label_prompt}</div>
                        )}
                        {expandedData.prompts_snapshot.rubric_items?.map((ri, i) => (
                          <div key={i}><strong>Rubric {i+1} ({ri.title}):</strong> {ri.scoring_prompt}</div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
