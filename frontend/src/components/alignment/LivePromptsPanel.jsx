import { useEffect } from 'react'
import HelpLabel from '../common/HelpLabel'
import { usePromptSync } from '../../store/promptSync'
import { TASK_SCHEMA, TaskEditor, setIn } from '../prompts/PromptBuilderPanel'

const TA = 'mt-1 block w-full px-3 py-2 text-sm bg-white border border-amber-200 rounded text-gray-900 focus:outline-none focus:border-amber-400'
const SMALL_TA = 'block w-full mt-1 px-2 py-1 text-sm bg-gray-50 border border-gray-300 rounded text-gray-900'
const NUM = 'mt-1 block w-24 px-2 py-1 text-sm bg-white border border-amber-200 rounded text-gray-900'

function NumberField({ label, help, value, onChange, step }) {
  return (
    <div>
      <HelpLabel label={label} help={help} />
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className={NUM}
      />
    </div>
  )
}

/**
 * Block-level prompts and settings for the selected block — every block type.
 * Edits go through the shared store (patchBlock): the Analysis Builder sees
 * them immediately and persists them; Builder edits show up here live.
 */
export function BlockPromptsPanel({ block, onPatch }) {
  if (!block) return null
  const d = block.data || {}
  const type = block.block_type

  function patchRubric(idx, field, value) {
    const items = [...(d.rubric_items || [])]
    items[idx] = { ...items[idx], [field]: value }
    onPatch({ rubric_items: items })
  }

  return (
    <div className="space-y-3">
      {type === 'sourceAnalysis' && (
        <>
          <div>
            <HelpLabel label="Detection Prompt" help="System prompt for TRUE/FALSE detection. The LLM uses this to decide if a text unit is relevant." />
            <textarea value={d.detection_prompt || ''} rows={3} className={TA}
              onChange={(e) => onPatch({ detection_prompt: e.target.value })} />
          </div>
          <div>
            <HelpLabel label="Label Prompt" help="Follow-up prompt for label assignment. Sent after a TRUE detection to get descriptive codes/themes." />
            <textarea value={d.label_prompt || ''} rows={3} className={TA}
              onChange={(e) => onPatch({ label_prompt: e.target.value })} />
          </div>
          <div className="flex gap-4">
            <NumberField label="Detection threshold (%)" help="Minimum detection confidence required before a label is requested." value={d.detection_threshold ?? 70}
              onChange={(v) => onPatch({ detection_threshold: v })} />
            <NumberField label="Label threshold (%)" help="Minimum label confidence to keep a label." value={d.label_threshold ?? 70}
              onChange={(v) => onPatch({ label_threshold: v })} />
          </div>
        </>
      )}

      {type === 'rubricAnalysis' && (
        <>
          {(d.rubric_items || []).map((item, idx) => (
            <details key={idx} className="bg-white border border-amber-200 rounded p-3">
              <summary className="cursor-pointer text-sm font-medium text-gray-800">
                Rubric {idx + 1}: {item.title || '(untitled)'}
              </summary>
              <div className="mt-2 space-y-2">
                <div>
                  <label className="text-gray-600 text-xs">Title</label>
                  <input value={item.title || ''} className={SMALL_TA}
                    onChange={(e) => patchRubric(idx, 'title', e.target.value)} />
                </div>
                <div>
                  <label className="text-gray-600 text-xs">Description</label>
                  <textarea value={item.description || ''} rows={2} className={SMALL_TA}
                    onChange={(e) => patchRubric(idx, 'description', e.target.value)} />
                </div>
                <div>
                  <HelpLabel label="Scoring Prompt" help="The LLM prompt used to score units against this rubric item." />
                  <textarea value={item.scoring_prompt || ''} rows={2} className={SMALL_TA}
                    onChange={(e) => patchRubric(idx, 'scoring_prompt', e.target.value)} />
                </div>
              </div>
            </details>
          ))}
          <NumberField label="Label threshold (%)" help="Scores below this confidence are left blank." value={d.label_threshold ?? 70}
            onChange={(v) => onPatch({ label_threshold: v })} />
        </>
      )}

      {type === 'customPrompt' && (
        <div>
          <HelpLabel label="Custom Prompt" help="Your custom prompt text sent to the LLM for this block." />
          <textarea value={d.prompt || ''} rows={5} className={TA}
            onChange={(e) => onPatch({ prompt: e.target.value })} />
        </div>
      )}

      {type === 'themeIdent' && (
        <NumberField label="Theme threshold (%)" help="Minimum confidence for a label to be matched to an existing theme (otherwise it is treated as a new theme)."
          value={d.theme_threshold ?? 80} onChange={(v) => onPatch({ theme_threshold: v })} />
      )}

      {type === 'categoryBuild' && (
        <NumberField label="Max categories" help="Upper limit on the number of categories the model may create from the theme list."
          value={d.max_categories ?? 6} onChange={(v) => onPatch({ max_categories: v })} />
      )}
    </div>
  )
}

/**
 * The surrounding prompt templates (system wrapper, unit intro, context
 * wrappers, reasoning follow-ups) for this block type — project-level
 * overrides, shared live with the Default Prompt Editor tab.
 */
export function TemplatesPanel({ projectId, blockType }) {
  const globalDefaults = usePromptSync(s => s.globalDefaults)
  const projectOverrides = usePromptSync(s => s.projectOverrides)
  const overridesStatus = usePromptSync(s => s.overridesStatus)
  const loadTemplates = usePromptSync(s => s.loadTemplates)
  const setProjectOverrides = usePromptSync(s => s.setProjectOverrides)

  useEffect(() => { loadTemplates(projectId) }, [projectId])

  const schema = TASK_SCHEMA[blockType]
  const tasks = (schema?.tasks || []).filter(t => t.id !== '__console') // activity-log templates aren't used in alignment
  if (tasks.length === 0) return null

  function handleEdit(path, value) {
    setProjectOverrides(prev => setIn(prev, path, value), { save: true })
  }

  function handleResetTask(bt, taskId) {
    setProjectOverrides(prev => {
      if (!prev[bt]) return prev
      const next = { ...prev, [bt]: { ...prev[bt] } }
      delete next[bt][taskId]
      return next
    }, { save: true })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-600">
          Saved to this project's prompt overrides (not the global defaults). Shared live with the Default Prompt Editor tab.
        </span>
        <span className="text-gray-500">
          {overridesStatus === 'saving' && 'Saving…'}
          {overridesStatus === 'saved' && 'All changes saved'}
          {overridesStatus === 'error' && <span className="text-red-600">Save failed — will retry on next edit</span>}
        </span>
      </div>
      {tasks.map(task => (
        <details key={task.id} className="bg-white border border-gray-200 rounded-lg">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-800">{task.label}</summary>
          <div className="p-3 border-t border-gray-200">
            <TaskEditor
              blockType={blockType}
              task={task}
              globalDefaults={globalDefaults}
              projectOverrides={projectOverrides}
              localEdits={{}}
              onEdit={handleEdit}
              onResetTask={handleResetTask}
            />
          </div>
        </details>
      ))}
    </div>
  )
}
