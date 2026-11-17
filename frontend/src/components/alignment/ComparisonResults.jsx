import { useState } from 'react'
import { getAlignmentTest, downloadAlignmentTest, downloadAlignmentCsv, downloadAlignmentReport } from '../../api'
import { saveBlob, formatTimestamp } from './downloadUtil'
import ReportMenu from './ReportMenu'
import MetricsSummary from './MetricsSummary'
import DetectionComparisonTable from './DetectionComparisonTable'
import LabelComparisonTable from './LabelComparisonTable'
import RubricComparisonTable from './RubricComparisonTable'

export default function ComparisonResults({ projectId, testData, blockType, testList }) {
  const [viewingTestId, setViewingTestId] = useState(null)
  const [viewData, setViewData] = useState(null)

  // Use either the actively loaded test or the passed-in testData
  const activeData = viewData || testData
  if (!activeData?.metrics) return null

  async function handleSelectTest(testId) {
    if (testId === testData?.test_id) {
      setViewData(null)
      setViewingTestId(null)
      return
    }
    try {
      const res = await getAlignmentTest(projectId, testId)
      setViewData(res.data)
      setViewingTestId(testId)
    } catch (err) {
      console.error('Failed to load test:', err)
    }
  }

  async function handleDownload(kind) {
    const tid = viewingTestId || activeData.test_id
    try {
      if (kind === 'csv') {
        saveBlob((await downloadAlignmentCsv(projectId, tid)).data, `${tid}_cases_and_codes.csv`)
      } else {
        saveBlob((await downloadAlignmentTest(projectId, tid)).data, `${tid}.json`)
      }
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-gray-900 font-medium">Comparison Results</h3>
        <div className="flex items-center gap-2">
          {testList && testList.length > 1 && (
            <select
              value={viewingTestId || activeData.test_id || ''}
              onChange={(e) => handleSelectTest(e.target.value)}
              className="px-2 py-1 text-xs bg-gray-50 border border-gray-300 rounded text-gray-900"
            >
              {testList.map(t => (
                <option key={t.test_id} value={t.test_id}>
                  {t.test_id} — {formatTimestamp(t.created_at, 'unknown')}
                </option>
              ))}
            </select>
          )}
          <ReportMenu
            fetcher={(fmt) => downloadAlignmentReport(projectId, viewingTestId || activeData.test_id, fmt)}
            filenameBase={viewingTestId || activeData.test_id}
          />
          {[['csv', 'Download CSV'], ['json', 'Download JSON']].map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => handleDownload(kind)}
              className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <MetricsSummary metrics={activeData.metrics} blockType={blockType} />

      {blockType === 'sourceAnalysis' && (
        <>
          <DetectionComparisonTable
            details={activeData.metrics?.detection?.details}
            llmResults={activeData.llm_results}
          />
          <LabelComparisonTable
            labelMetrics={activeData.metrics?.labels}
            humanLabels={activeData.human_labels}
            llmResults={activeData.llm_results}
          />
        </>
      )}

      {blockType === 'rubricAnalysis' && (
        <RubricComparisonTable
          rubricMetrics={activeData.metrics?.rubric_scores}
          humanLabels={activeData.human_labels}
          llmResults={activeData.llm_results}
          rubricItems={activeData.prompts_snapshot?.rubric_items}
        />
      )}
    </div>
  )
}
