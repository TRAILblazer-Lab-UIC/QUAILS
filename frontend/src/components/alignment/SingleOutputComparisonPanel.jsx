import HelpLabel from '../common/HelpLabel'

export default function SingleOutputComparisonPanel({
  blockType,
  contextText,
  humanExpected,
  onHumanExpectedChange,
  humanRationale,
  onHumanRationaleChange,
  llmOutput,
  onSaveTest,
  onRunComparison,
  autosaveStatus,
  isRunning,
}) {
  const label = blockType === 'categoryBuild' ? 'category grouping' : 'expected output'

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-xs text-amber-900">
        <p className="font-medium mb-1">Basic v1 alignment mode for {blockType === 'categoryBuild' ? 'Category Builder' : 'Custom Prompt'}</p>
        <p>
          This block runs as a single LLM call over all of its input at once, rather than one call per text unit, so
          there's no per-unit sample here — instead, write your own expected {label} below and compare it against
          what the AI produces for the same input. Deeper metrics for this mode are planned for a future update.
        </p>
      </div>

      <div>
        <HelpLabel label="Input the AI will see" help="The same context this block sends to the LLM." />
        <div className="mt-1 max-h-64 overflow-y-auto bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap">
          {contextText || '(no context available)'}
        </div>
      </div>

      <div>
        <HelpLabel
          label={`Your expected ${label}`}
          help={`Write what you would expect a good ${label} to look like, based on the input above. This is compared against the AI's actual output.`}
        />
        <textarea
          value={humanExpected}
          onChange={(e) => onHumanExpectedChange(e.target.value)}
          rows={8}
          placeholder={`Write your expected ${label} here...`}
          className="mt-1 block w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-indigo-400"
        />
      </div>

      <div>
        <HelpLabel
          label="Rationale (optional)"
          help="Why did you choose this? Optional. Not used in any alignment statistic — it is saved with your codes so it can inform prompt improvement later."
        />
        <textarea
          value={humanRationale || ''}
          onChange={(e) => onHumanRationaleChange(e.target.value)}
          rows={3}
          placeholder="Why do you expect this output?"
          className="mt-1 block w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:outline-none focus:border-indigo-400"
        />
      </div>

      {llmOutput != null && (
        <div>
          <HelpLabel label="AI's actual output" help="What the block's LLM call produced for this same input, from the most recent comparison run." />
          <div className="mt-1 max-h-64 overflow-y-auto bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap">
            {llmOutput}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={onSaveTest}
          className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
        >
          Save All
        </button>
        <button
          onClick={onRunComparison}
          disabled={isRunning || !humanExpected.trim()}
          className="px-4 py-2 text-sm font-medium bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors"
        >
          {isRunning ? 'Running...' : 'Run Alignment Comparison'}
        </button>
        <span className="text-xs text-gray-500">
          {autosaveStatus === 'saving' && 'Saving…'}
          {autosaveStatus === 'saved' && 'All changes saved'}
          {autosaveStatus === 'error' && (
            <span className="text-red-600">Autosave failed — click Save All to retry</span>
          )}
        </span>
      </div>
    </div>
  )
}
