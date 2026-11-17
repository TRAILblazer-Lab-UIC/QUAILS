import { Handle, Position } from '@xyflow/react'
import { useFlowOrder } from './FlowOrderContext'

export default function SourceAnalysisNode({ id, data }) {
  const sequenceOrder = useFlowOrder()
  const blockNum = id.split('_').pop()
  const seqNum = sequenceOrder[id]

  return (
    <div className="px-3 py-2 min-w-[200px]">
      <div className="flex items-center justify-between mb-1">
        <div className="text-indigo-600 text-xs font-semibold">Block ID: {blockNum}</div>
        {seqNum != null
          ? <div className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Step {seqNum}</div>
          : <div className="text-xs font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-500">–</div>
        }
      </div>
      <div className="text-gray-900 font-medium text-sm">{data.label || 'Open-Coding Analysis'}</div>
      <div className="text-gray-500 text-xs mt-1">Two-step LLM evaluation</div>
      {data.source_type === 'single' ? (
        <div className="text-indigo-600 text-xs mt-1 truncate">&#128196; {data.source_doc_label || 'Single doc'}</div>
      ) : data.source_type === 'folder' ? (
        <div className="text-indigo-600 text-xs mt-1 truncate">&#128193; {data.source_folder_name || 'Folder'}</div>
      ) : (
        <div className="text-gray-400 text-xs mt-1">All docs</div>
      )}
      {data.selected_columns?.length > 0 && (
        <div className="text-indigo-600 text-xs mt-1">
          {data.selected_columns.length} column(s) selected
        </div>
      )}
      <div className="text-gray-400 text-xs mt-1">
        {{
          sentence: 'Unit: Sentence',
          paragraph: 'Unit: Paragraph',
          document: 'Unit: Whole Doc',
          line: 'Unit: Row / Column',
        }[data.unit_type || 'sentence']}
      </div>
      {data.status && (
        <div className={`text-xs mt-1 ${data.status === 'complete' ? 'text-emerald-700' : 'text-amber-700'}`}>
          {data.status}
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-indigo-500 !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500 !w-3 !h-3" />
    </div>
  )
}
