import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  savePromptDefaults,
  saveProjectPromptOverrides,
  resetProjectPromptOverrides,
} from '../../api'
import { usePromptSync } from '../../store/promptSync'

// ---------------------------------------------------------------------------
// Schema: block types, tasks, fields, placeholders, and tooltips
// ---------------------------------------------------------------------------

const BLOCK_TYPES = [
  { id: 'sourceAnalysis', label: 'Open-Coding Analysis' },
  { id: 'rubricAnalysis', label: 'Rubric Analysis' },
  { id: 'themeIdent', label: 'Theme Identification' },
  { id: 'categoryBuild', label: 'Category Builder' },
  { id: 'customPrompt', label: 'Custom Prompt' },
]

export const TASK_SCHEMA = {
  sourceAnalysis: {
    tasks: [
      {
        id: 'detection',
        label: 'Detection',
        description: (
          <>
            Open-Coding Analysis works in two steps, much like how a human qualitative coder would conduct an open coding process: Step 1 is Detection, or whether the unit being analyzed has what you are looking for, and Step 2 is Labeling, which is giving it an open code, based on your instructions.
            <br /><br />
            This page is <strong>Step 1 — Detection</strong>. The AI reads each unit of text from your dataset (e.g., a sentence, paragraph, or row depending on your settings) and decides whether it contains content relevant to your research question, answering only TRUE or FALSE. Units marked TRUE move on to Step 2 (Labeling); units marked FALSE are logged separately and skipped. The templates on this page control every part of what the AI sees during detection: its overall instructions (the system prompt), how each unit of text is introduced, how surrounding context is framed, and how it is asked to explain its decision afterward. Your block's own detection prompt — the one you wrote in the Analysis Builder — is inserted automatically at the {'{{blockPrompt}}'} placeholder in the system prompt template.
          </>
        ),
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: ['blockPrompt'],
            tooltip: 'The system prompt is the AI\'s core instruction set — it tells the AI what role it\'s playing and what job it\'s doing before it reads any of your text. Think of it as a briefing you give the AI at the start of every analysis.\n\nThe {{blockPrompt}} placeholder marks where the detection prompt you wrote in your block\'s settings (in the Analysis Builder) will be inserted. You can add framing text before or after it — for example, a preamble about your research context that applies to every run of this block type.',
          },
          {
            key: 'unitIntro',
            label: 'Unit Introduction',
            type: 'textarea',
            placeholders: ['unitType'],
            tooltip: 'This short sentence is shown to the AI just before it reads each unit of text. It helps orient the AI to what kind of material it is about to analyze.\n\n{{unitType}} is automatically replaced with the unit type you have selected for the block — for example, "sentence", "paragraph", or "line". Providing a clear introduction can improve the AI\'s accuracy, especially when units are short or lack internal context.',
          },
          {
            key: 'contextPreTemplate',
            label: 'Pre-Context Template',
            type: 'textarea',
            placeholders: ['preContext'],
            tooltip: 'When you set a context window on a block, QUAILS includes text from neighboring units to help the AI understand the passage. This template controls how the text that appeared before the current unit is presented.\n\n{{preContext}} is replaced with the actual preceding text. This template is only sent to the AI when there is preceding context available — it is skipped entirely when there is none.',
          },
          {
            key: 'contextPostTemplate',
            label: 'Post-Context Template',
            type: 'textarea',
            placeholders: ['postContext'],
            tooltip: 'This template controls how the text that appeared after the current unit is presented to the AI when a context window is active.\n\n{{postContext}} is replaced with the actual following text. Like the pre-context template, this is only sent when following context is available.',
          },
          {
            key: 'reasoningPrompt',
            label: 'Reasoning Follow-up Prompt',
            type: 'textarea',
            placeholders: ['reasoningWords'],
            tooltip: 'After the AI answers TRUE or FALSE, this follow-up message asks it to briefly explain its thinking in plain language. The explanation is saved alongside the result and shown in the analysis console — it helps you audit and understand the AI\'s decisions.\n\n{{reasoningWords}} is replaced with the word limit set in the field below.',
          },
          {
            key: 'reasoningWords',
            label: 'Reasoning Word Limit',
            type: 'number',
            tooltip: 'The maximum number of words the AI should use when explaining its detection decision. Shorter limits (10–20 words) produce faster, scannable summaries. Higher limits allow more nuance but slow down analysis.',
          },
        ],
      },
      {
        id: 'labeling',
        label: 'Labeling',
        description: 'Step 2 — Labeling. After a unit passes the detection step (the AI answered TRUE), the same conversation continues and the AI is asked to assign a descriptive label to the unit.\n\nImportant: because labeling continues the same conversation, the unit text, surrounding context, and system instructions from Step 1 are already in the AI\'s memory — they are not re-sent. The label prompt you wrote in your individual block\'s settings (in the Analysis Builder) is what guides how the label is assigned. The templates on this page control only the follow-up question that asks the AI to justify its labeling choice.',
        fields: [
          {
            key: 'reasoningPrompt',
            label: 'Reasoning Follow-up Prompt',
            type: 'textarea',
            placeholders: ['reasoningWords'],
            tooltip: 'After the AI assigns a label, this message asks it to briefly explain in plain language why it chose that label. The explanation is saved with the result and shown in the console — useful for reviewing and auditing your labels.\n\n{{reasoningWords}} is replaced with the word limit set in the field below.',
          },
          {
            key: 'reasoningWords',
            label: 'Reasoning Word Limit',
            type: 'number',
            tooltip: 'The maximum number of words the AI should use when explaining its labeling decision. Shorter limits (10–20 words) produce faster, scannable summaries.',
          },
        ],
      },
      {
        id: '__console',
        label: 'Activity Log',
        description: 'When you start an analysis, a live activity window opens at the bottom of the screen and shows you what the AI is doing as it works through your data. These templates control what text appears in that window — they have no effect on your results.\n\nThe summary line appears once, right at the start, and displays a snapshot of your settings — which AI model is running, what thresholds are active, and which prompts are in use. This makes it easy to confirm everything is configured correctly before the results come in.\n\nThe per-item line appears for every piece of text as it is processed, showing you the outcome (labeled or skipped), a short preview of the text, and the AI\'s confidence level. You can adjust these templates to show more or less detail depending on how closely you want to monitor the run.',
        fields: [
          {
            key: 'consoleHeader',
            label: 'Run Summary (shown once at the start)',
            type: 'textarea',
            placeholders: ['model', 'temperature', 'seed', 'topK', 'topP', 'repeatPenalty', 'unitType', 'detectionThreshold', 'labelThreshold', 'totalUnits', 'startIndex', 'detectionPrompt', 'labelPrompt'],
            tooltip: 'This block of text appears once in the activity window right before the AI begins working. It gives you a summary of what settings are active for this run — the model being used, the prompts, the thresholds, and how many items will be processed.\n\nAll the {{…}} markers are automatically filled in with your real values. You can rearrange or remove lines to show exactly what you find useful.',
            hintText: '=== Open-Coding Analysis Starting ===\nModel: {{model}}  |  Unit type: {{unitType}}\nDetection threshold: {{detectionThreshold}}%  |  Label threshold: {{labelThreshold}}%\nTotal items to process: {{totalUnits}}  |  Starting from item: {{startIndex}}\n\nDetection prompt: {{detectionPrompt}}\nLabel prompt: {{labelPrompt}}',
          },
          {
            key: 'consoleUnit',
            label: 'Per-Item Update (shown for each item processed)',
            type: 'textarea',
            placeholders: ['verdict', 'unitId', 'snippet', 'label', 'confidence', 'reasoning'],
            tooltip: 'This line appears in the activity window for every item the AI processes. It lets you watch the analysis unfold in real time.\n\n{{verdict}} shows whether the item was labeled or skipped. {{snippet}} shows a short preview of the text being analyzed. {{confidence}} shows how certain the AI was. Adjust this to show more or less detail per item.',
            hintText: '[{{verdict}}]  {{unitId}}\n  "{{snippet}}"\n  → Label: {{label}}  |  Confidence: {{confidence}}%\n  → Reasoning: {{reasoning}}',
          },
        ],
      },
    ],
  },
  rubricAnalysis: {
    tasks: [
      {
        id: 'scoring',
        label: 'Scoring',
        description: 'Rubric Analysis scores every text unit against each of your rubric items in sequence. Unlike Open-Coding Analysis, there is no TRUE/FALSE gate — every unit is always scored against every rubric item. For each rubric item, the AI reads the unit and produces a score or response based on your scoring criteria.\n\nThe templates on this page control how the AI\'s instructions are assembled from your rubric item\'s title, description, and scoring prompt, as well as how the unit text and surrounding context are presented. Your rubric item fields (title, description, scoring criteria) from the Analysis Builder are inserted automatically via placeholders.',
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: ['rubricTitle', 'rubricDescription', 'blockPrompt'],
            tooltip: 'Assembles the AI\'s full instruction set for scoring each rubric item. The three placeholders pull directly from your rubric item\'s fields in the Analysis Builder:\n\n• {{rubricTitle}} — the name of the rubric item\n• {{rubricDescription}} — a longer description of what the item measures\n• {{blockPrompt}} — the scoring criteria / prompt you wrote for the item\n\nAll three are combined into a single set of instructions sent to the AI before it reads the unit.',
          },
          {
            key: 'unitIntro',
            label: 'Unit Introduction',
            type: 'textarea',
            placeholders: ['unitType'],
            tooltip: 'A short sentence shown to the AI before it reads each unit, helping orient it to the type of text it is about to score. {{unitType}} is replaced with the unit type you selected (e.g., "sentence" or "paragraph").',
          },
          {
            key: 'contextPreTemplate',
            label: 'Pre-Context Template',
            type: 'textarea',
            placeholders: ['preContext'],
            tooltip: 'Frames the text that appeared before the current unit when a context window is active. {{preContext}} is replaced with the actual preceding text. Only sent when preceding context is available.',
          },
          {
            key: 'contextPostTemplate',
            label: 'Post-Context Template',
            type: 'textarea',
            placeholders: ['postContext'],
            tooltip: 'Frames the text that appeared after the current unit when a context window is active. {{postContext}} is replaced with the actual following text. Only sent when following context is available.',
          },
          {
            key: 'reasoningPrompt',
            label: 'Reasoning Follow-up Prompt',
            type: 'textarea',
            placeholders: ['reasoningWords'],
            tooltip: 'After the AI scores each rubric item, this follow-up message asks it to briefly explain its reasoning in plain language. The explanation is saved alongside the result and shown in the analysis console — it helps you audit and understand the AI\'s decisions.\n\n{{reasoningWords}} is replaced with the word limit set in the field below.',
          },
          {
            key: 'reasoningWords',
            label: 'Reasoning Word Limit',
            type: 'number',
            tooltip: 'The maximum number of words the AI should use when explaining its scoring decision. Shorter limits (10–20 words) produce faster, scannable summaries. Higher limits allow more nuance but slow down analysis.',
          },
        ],
      },
      {
        id: '__console',
        label: 'Activity Log',
        description: 'When you run a Rubric Analysis, a live activity window opens at the bottom of the screen so you can watch the AI work through your data in real time. These templates control what text appears in that window — they have no effect on your scores or results.\n\nThe summary line appears once at the very start and shows a snapshot of your settings — the AI model, the number of rubric items, the scoring threshold, and how many items will be processed. This lets you confirm everything is set correctly before results start coming in.\n\nThe per-item line appears for each rubric item scored against each piece of text, showing you the score, the AI\'s confidence, and a brief justification. You can adjust these templates to show more or less detail.',
        fields: [
          {
            key: 'consoleHeader',
            label: 'Run Summary (shown once at the start)',
            type: 'textarea',
            placeholders: ['model', 'temperature', 'seed', 'topK', 'topP', 'repeatPenalty', 'unitType', 'rubricCount', 'labelThreshold', 'totalUnits', 'startIndex'],
            tooltip: 'This text appears once in the activity window right before scoring begins. It gives you a summary of your active settings — the model, the number of rubric items, the score threshold, and how many items will be processed.\n\nAll the {{…}} markers are automatically filled in with your real values.',
            hintText: '=== Rubric Analysis Starting ===\nModel: {{model}}  |  Unit type: {{unitType}}\nRubric items: {{rubricCount}}  |  Score threshold: {{labelThreshold}}%\nTotal items to process: {{totalUnits}}  |  Starting from item: {{startIndex}}',
          },
          {
            key: 'consoleUnit',
            label: 'Per-Item Update (shown for each item scored)',
            type: 'textarea',
            placeholders: ['unitId', 'rubricIndex', 'score', 'confidence', 'justification'],
            tooltip: 'This line appears in the activity window for each rubric item scored against each piece of text. {{rubricIndex}} is which rubric item is being scored (1, 2, 3…). {{score}} is the AI\'s score. {{confidence}} shows how certain it was. {{justification}} shows a brief excerpt of its reasoning.',
            hintText: '[Rubric {{rubricIndex}}]  {{unitId}}\n  Score: {{score}}  |  Confidence: {{confidence}}%\n  → {{justification}}',
          },
        ],
      },
    ],
  },
  themeIdent: {
    tasks: [
      {
        id: 'themeComparison',
        label: 'Theme Comparison',
        description: 'After Open-Coding Analysis or Rubric-Based Analysis assigns labels or scores to your text units, Theme Identification groups similar results together into themes using a method called "constant comparison." For each new label (or rubric score), the AI compares it to every theme identified so far and decides TRUE or FALSE: does this label belong to that theme? If no existing theme is a strong enough match, a new theme is created.\n\nThe templates on this page control exactly what the AI is told and asked during each comparison. The system prompt sets its role; the user message template is the specific question it is asked, filled in with the current label and the theme being compared.',
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: [],
            tooltip: 'The AI\'s role instruction for the comparison step. This is typically a brief statement telling the AI to respond only with TRUE or FALSE — it sets the rule for every comparison it makes across the entire analysis.',
          },
          {
            key: 'userTemplate',
            label: 'User Message Template',
            type: 'textarea',
            placeholders: ['label', 'reasoning', 'themeTitle', 'themeDescription'],
            tooltip: 'The specific question asked of the AI for each label-vs-theme comparison. Placeholders are filled in automatically:\n\n• {{label}} — the text label from Open-Coding Analysis, or the combined rubric score(s) from Rubric-Based Analysis\n• {{reasoning}} — the AI\'s reasoning from the labeling or scoring step\n• {{themeTitle}} — the title of the theme being compared\n• {{themeDescription}} — a short description of that theme\n\nThe AI responds TRUE if the label belongs to the theme, FALSE if it does not.',
          },
        ],
      },
      {
        id: 'titleGeneration',
        label: 'Title Generation',
        description: 'When a label does not match any existing theme well enough, a new theme is created and the AI is asked to generate a short 1–2 word title for it, based on the label and its rationale from the previous step. This title becomes the identifier for the new theme going forward.\n\nThe templates on this page control the instructions the AI receives and the information it is given to generate the title.',
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: [],
            tooltip: 'The AI\'s role instruction for theme title generation — typically a brief directive telling it to respond with only a short title (1–2 words). Keeping the instruction concise helps ensure the AI stays on task.',
          },
          {
            key: 'userTemplate',
            label: 'User Message Template',
            type: 'textarea',
            placeholders: ['label', 'reasoning'],
            tooltip: 'The message sent to the AI with the information it needs to generate a theme title. Placeholders are filled in automatically:\n\n• {{label}} — the label text that did not match any existing theme\n• {{reasoning}} — the AI\'s stated rationale for assigning that label\n\nThe AI responds with a short title that will represent the new theme.',
          },
        ],
      },
      {
        id: '__console',
        label: 'Activity Log',
        description: 'As the Theme Identification block works through your labeled data, a live activity window at the bottom of the screen shows you each assignment as it happens — which item is being processed, which theme it was matched to, and whether a new theme was created. This template controls what that update looks like. It has no effect on the themes or results themselves.',
        fields: [
          {
            key: 'consoleUnit',
            label: 'Per-Item Update (shown for each item processed)',
            type: 'textarea',
            placeholders: ['rowNum', 'themeId', 'themeTitle'],
            tooltip: 'This line appears in the activity window for each item as a theme is assigned to it. {{rowNum}} is the item\'s position in your data. {{themeId}} is the code assigned to the matched theme (e.g., T001). {{themeTitle}} is the theme\'s short name.',
            hintText: 'Row {{rowNum}}  →  Theme {{themeId}}: {{themeTitle}}',
          },
        ],
      },
    ],
  },
  categoryBuild: {
    tasks: [
      {
        id: 'categorization',
        label: 'Categorization',
        description: 'Category Builder takes all the themes identified in the previous step and asks the AI to organize them into a smaller set of broader categories — similar to creating chapter headings for a book of findings. Instead of dozens of specific themes, you end up with a handful of high-level groupings that are easier to interpret and report.\n\nThe AI receives the full list of themes and their descriptions in a single call and returns a structured markdown report. The templates on this page control the instructions it receives and how the theme list is formatted.',
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: ['maxCategories'],
            tooltip: 'The AI\'s instructions for organizing themes into categories. {{maxCategories}} is automatically replaced with the maximum number of categories you set in your block\'s settings in the Analysis Builder. You can adjust the framing, formatting requirements, or any other guidance here.',
          },
          {
            key: 'userTemplate',
            label: 'User Message Template',
            type: 'textarea',
            placeholders: ['themeSummary'],
            tooltip: 'The message that delivers the list of themes to the AI. {{themeSummary}} is automatically replaced with a formatted list of all themes from the upstream theme identification block, including each theme\'s ID, title, and description. You can add framing text around it if needed.',
          },
        ],
      },
      {
        id: '__console',
        label: 'Activity Log',
        description: 'When the Category Builder finishes organizing your themes into broader categories, a short completion message appears in the live activity window at the bottom of the screen. This template controls what that message says. It has no effect on the categories or the report that is generated.',
        fields: [
          {
            key: 'consoleComplete',
            label: 'Completion Message (shown when finished)',
            type: 'textarea',
            placeholders: ['maxCategories'],
            tooltip: 'This message appears in the activity window when the Category Builder block finishes. {{maxCategories}} is replaced with the maximum number of categories you set in your block\'s settings.',
            hintText: 'Categorization complete. Themes organized into up to {{maxCategories}} broad categories.',
          },
        ],
      },
    ],
  },
  customPrompt: {
    tasks: [
      {
        id: 'execution',
        label: 'Execution',
        description: 'The Custom Prompt block sends your own freeform prompt to the AI along with input data loaded from an upstream block. By default, both are passed through unchanged — so this block works exactly as you configured it in the Analysis Builder, with no modifications.\n\nThe templates on this page let you add framing or wrapper text around your prompt and input data without editing each block individually. This is useful if you want a consistent preamble or formatting instruction applied to every custom prompt block across your projects.',
        fields: [
          {
            key: 'systemTemplate',
            label: 'System Prompt Template',
            type: 'textarea',
            placeholders: ['blockPrompt'],
            tooltip: 'The system prompt sent to the AI for this block. {{blockPrompt}} is replaced with the custom prompt you wrote in your block\'s settings. The default passes it through unchanged.\n\nYou can add framing text before or after {{blockPrompt}} — for example, a research context statement or formatting instruction that applies to every custom prompt block.',
          },
          {
            key: 'userTemplate',
            label: 'User Message Template',
            type: 'textarea',
            placeholders: ['inputData'],
            tooltip: 'The user message sent to the AI along with its instructions. {{inputData}} is replaced with the input data loaded from your upstream block (e.g., a CSV, markdown file, or report). The default passes it through unchanged.\n\nYou can add framing text around {{inputData}} if you want the AI to receive the data in a specific format or with additional context.',
          },
        ],
      },
      {
        id: '__console',
        label: 'Activity Log',
        description: 'When a Custom Prompt block finishes running, a short completion message appears in the live activity window at the bottom of the screen. This template controls what that message says. It has no effect on what the AI produced.',
        fields: [
          {
            key: 'consoleComplete',
            label: 'Completion Message (shown when finished)',
            type: 'textarea',
            placeholders: ['blockId'],
            tooltip: 'This message appears in the activity window when this block completes its run. {{blockId}} is replaced with the block\'s unique ID from your flow.',
            hintText: 'Block {{blockId}} finished.',
          },
        ],
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMissingPlaceholders(value, placeholders) {
  if (!placeholders || placeholders.length === 0 || !value) return []
  return placeholders.filter(ph => !value.includes(`{{${ph}}}`))
}

function getIn(obj, path) {
  return path.reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj)
}

export function setIn(obj, path, value) {
  if (path.length === 0) return value
  const [head, ...rest] = path
  return { ...obj, [head]: setIn(obj[head] ?? {}, rest, value) }
}

function fieldPath(blockType, taskId, fieldKey) {
  if (taskId === '__console') return [blockType, fieldKey]
  return [blockType, taskId, fieldKey]
}

// ---------------------------------------------------------------------------
// Prompt preview helpers
// ---------------------------------------------------------------------------

function renderInlineTemplate(text) {
  if (!text && text !== 0) return <span className="text-gray-400 italic">(empty)</span>
  const parts = String(text).split(/(\{\{[^}]+\}\})/)
  return parts.map((part, i) => {
    if (/^\{\{[^}]+\}\}$/.test(part)) {
      return (
        <span key={i} className="inline-flex items-center px-1 rounded text-[10px] font-mono bg-indigo-50 text-indigo-600 border border-indigo-200 leading-tight mx-px">
          {part}
        </span>
      )
    }
    return <span key={i} className="whitespace-pre-wrap">{part}</span>
  })
}

// Returns an array of message descriptors describing the prompt assembly order for a task.
// Each descriptor is one of:
//   { type: 'message', role: 'system'|'user', label, content, note?, liveContent? }
//   { type: 'message_parts', role: 'user', label, note, parts: [{label, content, conditional?, liveContent?, liveLabel?}] }
//   { type: 'response', content }
//   { type: 'info', content }
// Returns null for __console tasks (not AI prompts).
function buildPromptStructure(blockType, taskId, getFieldValue) {
  if (taskId === '__console') return null

  switch (blockType) {
    case 'sourceAnalysis': {
      if (taskId === 'detection') {
        return [
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
            note: 'Sent once per unit as the AI\'s core instructions. {{blockPrompt}} is replaced with the detection prompt from your block settings.',
          },
          {
            type: 'message_parts',
            role: 'user',
            label: 'User Message',
            note: 'Assembled in sequence into a single user message.',
            parts: [
              {
                label: 'Unit Introduction',
                content: getFieldValue('unitIntro'),
              },
              {
                label: 'Unit Text',
                liveContent: true,
                liveLabel: '[actual text of the unit being analyzed]',
              },
              {
                label: 'Pre-Context',
                content: getFieldValue('contextPreTemplate'),
                conditional: 'only when context window is active',
              },
              {
                label: 'Post-Context',
                content: getFieldValue('contextPostTemplate'),
                conditional: 'only when context window is active',
              },
            ],
          },
          { type: 'response', content: 'TRUE  or  FALSE' },
          {
            type: 'message',
            role: 'user',
            label: 'Reasoning Follow-up',
            content: getFieldValue('reasoningPrompt'),
            note: 'Appended to the same conversation to request a brief explanation.',
          },
          { type: 'response', content: '[brief reasoning in plain language]' },
        ]
      }
      if (taskId === 'labeling') {
        return [
          {
            type: 'info',
            content: 'Labeling continues the same conversation as Detection. The system prompt, unit text, and the AI\'s TRUE/FALSE answer are already in the conversation history — they are not re-sent.',
          },
          {
            type: 'message',
            role: 'user',
            label: 'User Message',
            liveContent: true,
            content: '[label prompt from your block\'s settings in the Analysis Builder]',
            note: 'Your label prompt is appended directly to the ongoing conversation.',
          },
          { type: 'response', content: '[a descriptive label]' },
          {
            type: 'message',
            role: 'user',
            label: 'Reasoning Follow-up',
            content: getFieldValue('reasoningPrompt'),
            note: 'Appended to the same conversation to request a brief explanation.',
          },
          { type: 'response', content: '[brief reasoning in plain language]' },
        ]
      }
      break
    }
    case 'rubricAnalysis': {
      if (taskId === 'scoring') {
        return [
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
            note: 'Built from your rubric item\'s title, description, and scoring criteria. A fresh message set is created for each rubric item.',
          },
          {
            type: 'message_parts',
            role: 'user',
            label: 'User Message',
            note: 'Assembled in sequence into a single user message.',
            parts: [
              {
                label: 'Unit Introduction',
                content: getFieldValue('unitIntro'),
              },
              {
                label: 'Unit Text',
                liveContent: true,
                liveLabel: '[actual text of the unit being analyzed]',
              },
              {
                label: 'Pre-Context',
                content: getFieldValue('contextPreTemplate'),
                conditional: 'only when context window is active',
              },
              {
                label: 'Post-Context',
                content: getFieldValue('contextPostTemplate'),
                conditional: 'only when context window is active',
              },
            ],
          },
          { type: 'response', content: '[a score or response for this rubric item]' },
          {
            type: 'message',
            role: 'user',
            label: 'Reasoning Follow-up',
            content: getFieldValue('reasoningPrompt'),
            note: 'Appended to the same conversation to request a brief explanation.',
          },
          { type: 'response', content: '[brief reasoning in plain language]' },
        ]
      }
      break
    }
    case 'themeIdent': {
      if (taskId === 'themeComparison') {
        return [
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
            note: 'Sent once per label-vs-theme comparison. This call is repeated for every existing theme.',
          },
          {
            type: 'message',
            role: 'user',
            label: 'User Message',
            content: getFieldValue('userTemplate'),
            note: 'Filled in with the current label, its reasoning, and the theme being compared.',
          },
          { type: 'response', content: 'TRUE  or  FALSE' },
        ]
      }
      if (taskId === 'titleGeneration') {
        return [
          {
            type: 'info',
            content: 'Title Generation runs only when no existing theme matches above the threshold. A fresh conversation is started to name the new theme.',
          },
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
          },
          {
            type: 'message',
            role: 'user',
            label: 'User Message',
            content: getFieldValue('userTemplate'),
            note: 'Filled in with the unmatched label and its reasoning.',
          },
          { type: 'response', content: '[1–2 word theme title]' },
        ]
      }
      break
    }
    case 'categoryBuild': {
      if (taskId === 'categorization') {
        return [
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
            note: 'Sent once — the entire theme list is processed in a single call.',
          },
          {
            type: 'message',
            role: 'user',
            label: 'User Message',
            content: getFieldValue('userTemplate'),
            note: 'The full list of themes from the upstream block is substituted into {{themeSummary}}.',
          },
          { type: 'response', content: '[a markdown-formatted category report]' },
        ]
      }
      break
    }
    case 'customPrompt': {
      if (taskId === 'execution') {
        return [
          {
            type: 'message',
            role: 'system',
            label: 'System Message',
            content: getFieldValue('systemTemplate'),
            note: 'Your custom prompt is substituted into {{blockPrompt}}.',
          },
          {
            type: 'message',
            role: 'user',
            label: 'User Message',
            content: getFieldValue('userTemplate'),
            note: 'The upstream block\'s output is substituted into {{inputData}}.',
          },
          { type: 'response', content: '[AI response based on your custom prompt and input]' },
        ]
      }
      break
    }
    default:
      break
  }
  return []
}

// ---------------------------------------------------------------------------
// PromptPreview
// ---------------------------------------------------------------------------

const ROLE_STYLES = {
  system: {
    label: 'SYSTEM',
    headerBg: 'bg-violet-50',
    text: 'text-violet-800',
    border: 'border-violet-200',
  },
  user: {
    label: 'USER',
    headerBg: 'bg-sky-50',
    text: 'text-sky-800',
    border: 'border-sky-200',
  },
}

function PromptPreview({ blockType, taskId, getFieldValue }) {
  const [expanded, setExpanded] = useState(false)
  const isConsole = taskId === '__console'

  // Compute structure on render so it always reflects current field values
  const structure = isConsole ? null : buildPromptStructure(blockType, taskId, getFieldValue)

  return (
    <div className="mt-6 border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-left transition-colors"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-gray-600">
          <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Preview full prompt structure
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 py-4 bg-white border-t border-gray-200">
          {isConsole ? (
            <p className="text-xs text-gray-500 italic leading-relaxed">
              These templates format the activity log display — they control what appears in the live console window, not what is sent to the AI. There is no prompt structure to preview.
            </p>
          ) : structure && structure.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <p className="text-[10px] text-gray-400 mb-1 leading-relaxed">
                Read-only preview of how the templates above are sequenced to build the actual messages sent to the AI. Values shown reflect your current edits. <span className="inline-flex items-center px-1 rounded font-mono bg-indigo-50 text-indigo-600 border border-indigo-200">{'{{markers}}'}</span> will be replaced with real content at run time.
              </p>
              {structure.map((item, idx) => {
                if (item.type === 'info') {
                  return (
                    <div key={idx} className="flex items-start gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-700 leading-relaxed">
                      <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>{item.content}</span>
                    </div>
                  )
                }

                if (item.type === 'response') {
                  return (
                    <div key={idx} className="flex items-center gap-2 pl-3 py-1">
                      <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                      <span className="text-[10px] text-gray-400">
                        AI responds:{' '}
                        <span className="font-medium text-emerald-700 font-mono">{item.content}</span>
                      </span>
                    </div>
                  )
                }

                if (item.type === 'message') {
                  const style = ROLE_STYLES[item.role] || ROLE_STYLES.user
                  return (
                    <div key={idx} className={`rounded-lg border ${style.border} overflow-hidden`}>
                      <div className={`flex items-start justify-between gap-3 px-3 py-1.5 ${style.headerBg} border-b ${style.border}`}>
                        <span className={`text-[10px] font-bold font-mono tracking-wider shrink-0 ${style.text}`}>
                          {item.label || style.label}
                        </span>
                        {item.note && (
                          <span className="text-[10px] text-gray-400 italic leading-tight text-right">{item.note}</span>
                        )}
                      </div>
                      <div className="px-3 py-2 bg-white">
                        {item.liveContent ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-500 border border-dashed border-gray-300">
                            {item.content}
                          </span>
                        ) : (
                          <p className="text-xs font-mono text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                            {renderInlineTemplate(item.content)}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                }

                if (item.type === 'message_parts') {
                  const style = ROLE_STYLES[item.role] || ROLE_STYLES.user
                  return (
                    <div key={idx} className={`rounded-lg border ${style.border} overflow-hidden`}>
                      <div className={`flex items-start justify-between gap-3 px-3 py-1.5 ${style.headerBg} border-b ${style.border}`}>
                        <span className={`text-[10px] font-bold font-mono tracking-wider shrink-0 ${style.text}`}>
                          {item.label || style.label}
                        </span>
                        {item.note && (
                          <span className="text-[10px] text-gray-400 italic leading-tight text-right">{item.note}</span>
                        )}
                      </div>
                      <div className="bg-white divide-y divide-gray-100">
                        {item.parts.map((part, pi) => (
                          <div key={pi} className="px-3 py-2">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{part.label}</span>
                              {part.conditional && (
                                <span className="text-[10px] px-1.5 py-px rounded bg-amber-50 text-amber-600 border border-amber-200 leading-tight">
                                  {part.conditional}
                                </span>
                              )}
                            </div>
                            {part.liveContent ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-500 border border-dashed border-gray-300">
                                {part.liveLabel || '[live content]'}
                              </span>
                            ) : (
                              <p className="text-xs font-mono text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                                {renderInlineTemplate(part.content)}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }

                return null
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-400 italic">No preview available for this task.</p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FieldTooltip
// ---------------------------------------------------------------------------

function FieldTooltip({ text, marginClass = 'ml-3' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const outerRef = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (outerRef.current && !outerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function computePos() {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const tooltipW = 340
    const margin = 12
    let left = rect.right + margin
    // Flip left if tooltip would overflow right edge
    if (left + tooltipW > window.innerWidth - 16) {
      left = rect.left - tooltipW - margin
    }
    setPos({ top: rect.top, left })
  }

  function handleMouseEnter() {
    computePos()
    setOpen(true)
  }

  function handleClick() {
    if (!open) computePos()
    setOpen((v) => !v)
  }

  return (
    <span ref={outerRef} className={`relative inline-flex items-center ${marginClass} shrink-0`}>
      <button
        ref={btnRef}
        type="button"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setOpen(false)}
        onClick={handleClick}
        className="w-4 h-4 rounded-full bg-sky-100 text-sky-700 border border-sky-300 text-[10px] font-bold flex items-center justify-center hover:bg-sky-200 hover:text-sky-900 transition-colors focus:outline-none leading-none"
        aria-label="More information"
      >
        ?
      </button>
      {open && pos && createPortal(
        <div
          className="fixed z-[9999] p-3 bg-gray-900 text-white text-xs rounded-lg shadow-xl pointer-events-none leading-relaxed whitespace-pre-line"
          style={{ top: pos.top, left: pos.left, width: 340 }}
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Placeholder descriptions (plain-language, for lay audience)
// ---------------------------------------------------------------------------

const PLACEHOLDER_DESCRIPTIONS = {
  blockPrompt: `Your research prompt — the specific instructions or question you wrote for this block in the Analysis Builder. This is how your personal guidance reaches the AI each time it runs. Without it, the AI has no idea what you are studying and will produce generic results.`,
  unitType: `The type of text chunk this block is analyzing — for example the word "sentence", "paragraph", or "line". Tells the AI what kind of piece it is about to read, which helps it respond in the right way.`,
  preContext: `The text that appeared just before the current chunk in your original document. When a context window is active, this gives the AI background so it can understand the current piece in the flow of the passage rather than reading it cold.`,
  postContext: `The text that appeared just after the current chunk in your document. Together with the pre-context, it lets the AI read each piece in its surrounding passage rather than in isolation.`,
  reasoningWords: `The word limit you set in the Reasoning Word Limit field just below. For example, if you enter 20, this becomes the number 20 in the prompt, telling the AI exactly how long its explanation should be.`,
  rubricTitle: `The short name you gave this rubric item in the Analysis Builder — for example "Clarity" or "Evidence Quality". Identifies which specific criterion the AI is currently scoring.`,
  rubricDescription: `The longer description you wrote for this rubric item — the explanation that tells the AI what the criterion means and what to look for when scoring it. Without it, the AI only sees the short title and has to guess at the full meaning.`,
  label: `The short descriptive tag assigned to this text unit in the previous step — either the open code from Open-Coding Analysis or a summary of rubric scores. This is what the AI uses to decide which theme the unit might belong to.`,
  reasoning: `The AI's brief written explanation from the previous step — the rationale it gave for assigning a label or score. Including it here gives the AI richer context when comparing labels to themes, rather than relying on the label text alone.`,
  themeTitle: `The short title of one existing theme — for example "Teacher Stress" or "Student Engagement". The AI compares each new label against every existing theme one by one, and this fills in the name of whichever theme is currently being evaluated.`,
  themeDescription: `A brief description of an existing theme, explaining what it represents and which kinds of labels belong to it. Helps the AI judge whether a new label is a good match, beyond just reading the theme's title.`,
  maxCategories: `The maximum number of categories you set in your Category Builder block settings — for example the number 5. Tells the AI how many broad groups it is allowed to create.`,
  themeSummary: `The complete list of themes found in the previous step — each theme's ID, title, and description — formatted as a readable list. This is the full set of information the AI works from when grouping themes into broader categories.`,
  inputData: `The actual content loaded from the block connected above this one in your flow — for example, the rows of a CSV file, a written report, or a plain text document. This is the material the AI reads and responds to.`,
  blockId: `This block's unique ID code from your flow — a short identifier like "blk_a1b2". Used in console log templates so each line of output is labeled with which block produced it. Does not affect the AI's analysis.`,
  model: `The name of the AI model used for this run — for example "gemma3" or "gpt-4o". Recorded in the console log header so you have a permanent reference to which model was active when the results were produced.`,
  temperature: `The Temperature setting from your Project Spec block. Controls how "creative" or varied the AI's responses are — a value of 0 means maximally consistent, repeatable results. Recorded in the console log header for reference.`,
  seed: `The Seed number from your Project Spec block. Running the same analysis with the same seed and model settings should produce the same results each time — important for reproducible research. Recorded in the console log header.`,
  topK: `The Top-K value from your Project Spec block. A setting that limits how many word choices the AI considers at each step — lower values make it more focused. Recorded in the console log header; does not need to appear in AI-facing prompt templates.`,
  topP: `The Top-P value from your Project Spec block. Works alongside Top-K to shape how the AI selects its words, based on probability. Recorded in the console log header alongside Top-K.`,
  repeatPenalty: `The Repeat Penalty value from your Project Spec block. Discourages the AI from repeating the same words or phrases — higher values produce more varied language. Recorded in the console log header.`,
  detectionThreshold: `The detection confidence threshold set on this block — a number from 0 to 100 representing how certain the AI must be before marking a unit as relevant. Units below this number are skipped. Recorded in the console log header so you know exactly which threshold was active.`,
  labelThreshold: `The label or score confidence threshold set on this block — the minimum certainty required for a result to be recorded in the output. Results below this are left blank. Recorded in the console log header.`,
  totalUnits: `The total number of text chunks being processed in this run — for example "200" if your document was divided into 200 sentences. Appears in the console log header so you can see the scale of the analysis immediately.`,
  startIndex: `The unit number where processing begins. On a fresh run this is 1. When resuming an interrupted run, it shows the number where the analysis picked back up, so you can confirm the resume worked correctly.`,
  detectionPrompt: `The full text of the detection prompt you wrote for this block in the Analysis Builder — the instructions that guided the AI's TRUE/FALSE decision. Recorded exactly in the console log header so you have a complete audit trail.`,
  labelPrompt: `The full text of the labeling prompt you wrote for this block in the Analysis Builder — the instructions that told the AI how to assign a label. Recorded in the console log header alongside the detection prompt.`,
  verdict: `The outcome for the current text unit: the word LABEL if it passed detection and received a label, or SKIP if it did not pass and was set aside. Appears on every line of the per-unit console log.`,
  unitId: `The tracking code for the current text unit — a short identifier showing which document it came from and where it appeared, like "a3f2-001-S-0042". Lets you trace any console log entry back to its exact source in your original data.`,
  snippet: `A short preview of the text unit being processed — typically the first few words of the sentence or paragraph. Appears on each log line so you can see at a glance what the AI was reading for each decision.`,
  confidence: `The AI's certainty score for its decision, as a number from 0 to 100. Higher means more confident; lower may be worth a closer look. Appears on each per-unit log line.`,
  rubricIndex: `The number of the rubric item currently being scored — 1 for the first, 2 for the second, and so on. Appears on each log line so you can tell which criterion each result belongs to.`,
  score: `The AI's score or response for this rubric item — for example "Yes", "No", or "3/5", depending on your rubric. Blank if the AI's confidence was below your threshold. Appears on each per-unit log line.`,
  justification: `A short excerpt of the AI's explanation for the score it gave. Appears on each log line to help you quickly audit whether the AI's decisions make sense.`,
  rubricCount: `The total number of rubric items defined in this block — for example "4" if you set up four items. Appears in the console log header so you can confirm the right number of criteria were active during the run.`,
  rowNum: `The row number of the current text unit being processed — 1 for the first, 2 for the second. Appears on each log line as a simple counter so you can track progress and locate specific entries.`,
  themeId: `The unique code assigned to the theme matched or created for the current unit — for example "T001" or "T012". Each new theme gets its own code when first created. Appears on each log line so you can follow theme assignments in real time.`,
}

// ---------------------------------------------------------------------------
// PlaceholderChip
// ---------------------------------------------------------------------------

function PlaceholderChip({ name, tooltip, onClick }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const outerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (outerRef.current && !outerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function computePosFromEl(el) {
    if (!el) return
    const rect = el.getBoundingClientRect()
    const tooltipW = 340
    const margin = 8
    let left = rect.right + margin
    if (left + tooltipW > window.innerWidth - 16) {
      left = rect.left - tooltipW - margin
    }
    setPos({ top: rect.top, left })
  }

  return (
    <span ref={outerRef} className="inline-flex items-center">
      <button
        type="button"
        onMouseEnter={(e) => { computePosFromEl(e.currentTarget); setOpen(true) }}
        onMouseLeave={() => setOpen(false)}
        onClick={() => onClick(name)}
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors"
      >
        {`{{${name}}}`}
      </button>
      {open && pos && tooltip && createPortal(
        <div
          className="fixed z-[9999] p-3 bg-gray-900 text-white text-xs rounded-lg shadow-xl pointer-events-none leading-relaxed whitespace-pre-line"
          style={{ top: pos.top, left: pos.left, width: 340 }}
        >
          {tooltip}
        </div>,
        document.body
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// TaskEditor
// ---------------------------------------------------------------------------

export function TaskEditor({ blockType, task, globalDefaults, projectOverrides, localEdits, onEdit, onResetTask }) {
  const textareaRefs = useRef({})

  function getFieldValue(fieldKey) {
    const path = fieldPath(blockType, task.id, fieldKey)
    const fromLocal = getIn(localEdits, path)
    if (fromLocal !== undefined) return fromLocal
    const fromOverride = getIn(projectOverrides, path)
    if (fromOverride !== undefined) return fromOverride
    return getIn(globalDefaults, path) ?? ''
  }

  function isOverridden(fieldKey) {
    const path = fieldPath(blockType, task.id, fieldKey)
    return getIn(localEdits, path) !== undefined || getIn(projectOverrides, path) !== undefined
  }

  function handleChange(fieldKey, value) {
    const path = fieldPath(blockType, task.id, fieldKey)
    onEdit(path, value)
  }

  function insertPlaceholder(fieldKey, name) {
    const el = textareaRefs.current[fieldKey]
    const current = getFieldValue(fieldKey) ?? ''
    if (!el) {
      handleChange(fieldKey, current + `{{${name}}}`)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = current.slice(0, start) + `{{${name}}}` + current.slice(end)
    handleChange(fieldKey, next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + name.length + 4, start + name.length + 4)
    })
  }

  const taskHasPlaceholders = task.fields.some(f => f.placeholders && f.placeholders.length > 0)

  return (
    <div className="flex flex-col gap-4">
      {/* Task description */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-xs text-gray-600 leading-relaxed">
        <div className="whitespace-pre-line">{task.description}</div>
        {taskHasPlaceholders && (
          <div className="mt-3 pt-3 border-t border-gray-300 text-gray-500">
            {task.id === '__console' ? (
              <>
                <span className="font-semibold text-gray-700">How the {'{{…}}'} markers work in readouts: </span>
                Each marker is a live value that gets filled in automatically as the analysis runs. For example,{' '}
                <span className="font-mono bg-white border border-gray-300 px-0.5 rounded text-gray-700">{'{{model}}'}</span>
                {' '}is replaced with the name of the AI being used, and{' '}
                <span className="font-mono bg-white border border-gray-300 px-0.5 rounded text-gray-700">{'{{totalUnits}}'}</span>
                {' '}becomes the actual number of items being processed — values you would not know ahead of time. Click any marker button to insert it at your cursor in the template below.
                <div className="mt-2.5 font-semibold text-gray-700">How to write a readout line:</div>
                <div className="mt-1">Type whatever text you want to appear, and insert markers where you want live values. Plain text always stays exactly as written — markers get replaced with real values automatically. You can use multiple lines.</div>
                <div className="mt-2.5 font-semibold text-gray-600">Example:</div>
                <div className="mt-1 font-mono bg-white border border-gray-300 px-2 py-1.5 rounded text-gray-700 text-[10px] whitespace-pre">{'[{{verdict}}]  {{unitId}}  —  Confidence: {{confidence}}%'}</div>
                <div className="mt-1.5 text-[10px]">…would appear during a run as something like:</div>
                <div className="mt-1 font-mono bg-white border border-gray-300 px-2 py-1.5 rounded text-gray-500 text-[10px]">{'[LABEL]  a3f2-001-S-0042  —  Confidence: 87.3%'}</div>
              </>
            ) : (
              <>
                <span className="font-semibold text-gray-700">About the {'{{placeholder}}'} markers below: </span>
                These are fill-in-the-blank spots in your template. When QUAILS runs an analysis, it automatically replaces each{' '}
                <span className="font-mono bg-white border border-gray-300 px-0.5 rounded text-gray-700">{'{{…}}'}</span>
                {' '}marker with real content before the AI ever reads the text — for example,{' '}
                <span className="font-mono bg-white border border-gray-300 px-0.5 rounded text-gray-700">{'{{blockPrompt}}'}</span>
                {' '}becomes the specific research prompt you wrote in the Analysis Builder. Click any marker button below to insert it into your template at the cursor position. Hover over a marker to learn what it does.
              </>
            )}
          </div>
        )}
      </div>

      {task.fields.map((field) => {
        const value = getFieldValue(field.key)
        const overridden = isOverridden(field.key)

        if (field.type === 'number') {
          return (
            <div key={field.key} className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 flex items-center gap-3">
              <label className="flex items-center text-xs text-gray-700 font-medium shrink-0">
                {field.label}
                {field.tooltip && <FieldTooltip text={field.tooltip} />}
                {overridden && <span className="ml-1 text-amber-600">*</span>}
              </label>
              <input
                type="number"
                value={value ?? ''}
                onChange={(e) => handleChange(field.key, e.target.value === '' ? '' : Number(e.target.value))}
                className="w-24 px-2 py-1 text-sm border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                min={1}
              />
            </div>
          )
        }

        // textarea
        return (
          <div key={field.key} className="rounded-lg border border-gray-200 bg-gray-50 p-5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <label className="flex items-center text-xs font-semibold text-gray-700 shrink-0">
                {field.label}
                {field.tooltip && <FieldTooltip text={field.tooltip} />}
                {overridden && <span className="ml-1 text-amber-600" title="Modified">*</span>}
              </label>
              {field.placeholders && field.placeholders.length > 0 && (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex flex-wrap gap-1 justify-end">
                    {field.placeholders.map((ph) => (
                      <PlaceholderChip
                        key={ph}
                        name={ph}
                        tooltip={PLACEHOLDER_DESCRIPTIONS[ph]}
                        onClick={(name) => insertPlaceholder(field.key, name)}
                      />
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-400 leading-tight text-right">
                    {task.id === '__console'
                      ? "Click a {{…}} placeholder to add that variable to your activity log readout."
                      : "Click a {{…}} placeholder to insert it at your cursor — omitting these placeholders means the AI won't receive that content from your data."}
                  </p>
                </div>
              )}
            </div>
            {(() => {
              const isConsole = task.id === '__console'
              const missing = isConsole ? [] : getMissingPlaceholders(value, field.placeholders)
              const hintPh = field.placeholders && field.placeholders.length > 0 ? field.placeholders[0] : null
              const placeholderHint = field.hintText
                ? field.hintText
                : hintPh
                  ? `Enter template text. Use the {{…}} buttons to insert placeholders — e.g. {{${hintPh}}}.`
                  : 'Enter template text.'
              return (
                <>
                  <textarea
                    ref={(el) => { textareaRefs.current[field.key] = el }}
                    value={value ?? ''}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    rows={field.key.includes('Header') || field.key.includes('system') || field.key.includes('Template') ? 6 : 3}
                    placeholder={placeholderHint}
                    className={`w-full px-3 py-2 text-xs font-mono rounded-lg focus:outline-none focus:ring-1 resize-y leading-relaxed placeholder:text-gray-400 placeholder:font-sans ${
                      missing.length > 0 && value
                        ? 'border border-amber-400 focus:ring-amber-400'
                        : 'border border-gray-300 focus:ring-indigo-400'
                    }`}
                    spellCheck={false}
                  />
                  {missing.length > 0 && value && (
                    <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mt-1">
                      <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      </svg>
                      <span>
                        Missing placeholder{missing.length > 1 ? 's' : ''}: <span className="font-mono">{missing.map(p => `{{${p}}}`).join(', ')}</span> — without {missing.length > 1 ? 'these' : 'this'}, the AI won't receive that content when the block runs.
                      </span>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        )
      })}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onResetTask(blockType, task.id)}
          className="px-3 py-1.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          title="Clear local edits and project overrides for this task, reverting to global defaults"
        >
          Reset this Task to Global Default
        </button>
      </div>

      <PromptPreview
        blockType={blockType}
        taskId={task.id}
        getFieldValue={getFieldValue}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PromptBuilderPanel({ projectId }) {
  const [scope, setScope] = useState('project') // 'project' | 'global'
  // Templates live in a shared store so edits made from the Alignment tab show
  // up here instantly (and vice versa) without a reload.
  const globalDefaults = usePromptSync(s => s.globalDefaults)
  const projectOverrides = usePromptSync(s => s.projectOverrides)
  const setGlobalDefaults = usePromptSync(s => s.setGlobalDefaults)
  const setProjectOverrides = usePromptSync(s => s.setProjectOverrides)
  const loadTemplates = usePromptSync(s => s.loadTemplates)
  const [localEdits, setLocalEdits] = useState({})
  const [activeBlockType, setActiveBlockType] = useState('sourceAnalysis')
  const [activeTask, setActiveTask] = useState('detection')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  useEffect(() => {
    loadTemplates(projectId)
  }, [projectId])

  useEffect(() => {
    const schema = TASK_SCHEMA[activeBlockType]
    if (schema && schema.tasks.length > 0) {
      setActiveTask(schema.tasks[0].id)
    }
  }, [activeBlockType])

  function showToast(type, message) {
    setToast({ type, message })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  function handleEdit(path, value) {
    setLocalEdits((prev) => setIn(prev, path, value))
  }

  function mergeLocalInto(base) {
    function deepMerge(b, o) {
      const result = { ...b }
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof result[k] === 'object') {
          result[k] = deepMerge(result[k] ?? {}, v)
        } else {
          result[k] = v
        }
      }
      return result
    }
    return deepMerge(base, localEdits)
  }

  function countLocalEditsMissingPlaceholders() {
    let count = 0
    for (const [blockType, blockData] of Object.entries(localEdits)) {
      const schema = TASK_SCHEMA[blockType]
      if (!schema) continue
      for (const task of schema.tasks) {
        if (task.id === '__console') continue
        for (const field of task.fields) {
          if (!field.placeholders || field.placeholders.length === 0) continue
          const path = fieldPath(blockType, task.id, field.key)
          const value = getIn(localEdits, path)
          if (!value || typeof value !== 'string') continue
          if (getMissingPlaceholders(value, field.placeholders).length > 0) count++
        }
      }
    }
    return count
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (scope === 'project') {
        const next = mergeLocalInto(projectOverrides)
        await saveProjectPromptOverrides(projectId, next)
        setProjectOverrides(next)
      } else {
        const next = mergeLocalInto(globalDefaults)
        await savePromptDefaults(next)
        setGlobalDefaults(next)
      }
      const missingCount = countLocalEditsMissingPlaceholders()
      setLocalEdits({})
      if (missingCount > 0) {
        showToast('warning', `Saved — but ${missingCount} field${missingCount > 1 ? 's are' : ' is'} missing recommended placeholders. Check highlighted fields.`)
      } else {
        showToast('success', 'Templates saved')
      }
    } catch (err) {
      console.error('Save failed:', err)
      showToast('error', 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleResetProjectOverrides() {
    if (!confirm('Reset all individual project prompts? This project will revert to the global defaults for all templates.')) return
    try {
      await resetProjectPromptOverrides(projectId)
      setProjectOverrides({})
      setLocalEdits({})
      showToast('success', 'Project prompts reset to global defaults')
    } catch (err) {
      showToast('error', 'Reset failed')
    }
  }

  function handleResetTask(blockType, taskId) {
    setLocalEdits((prev) => {
      const next = { ...prev }
      if (taskId === '__console') {
        if (next[blockType]) {
          const bt = { ...next[blockType] }
          const schema = TASK_SCHEMA[blockType]
          const consoleTask = schema?.tasks.find((t) => t.id === '__console')
          if (consoleTask) consoleTask.fields.forEach((f) => delete bt[f.key])
          next[blockType] = bt
        }
      } else {
        if (next[blockType]) {
          const bt = { ...next[blockType] }
          delete bt[taskId]
          next[blockType] = bt
        }
      }
      return next
    })
    if (scope === 'project') {
      setProjectOverrides((prev) => {
        const next = { ...prev }
        if (taskId === '__console') {
          if (next[blockType]) {
            const bt = { ...next[blockType] }
            const schema = TASK_SCHEMA[blockType]
            const consoleTask = schema?.tasks.find((t) => t.id === '__console')
            if (consoleTask) consoleTask.fields.forEach((f) => delete bt[f.key])
            next[blockType] = bt
          }
        } else {
          if (next[blockType]) {
            const bt = { ...next[blockType] }
            delete bt[taskId]
            next[blockType] = bt
          }
        }
        return next
      }, { save: true })
    }
  }

  const currentSchema = TASK_SCHEMA[activeBlockType]
  const currentTask = currentSchema?.tasks.find((t) => t.id === activeTask)
  const hasLocalEdits = Object.keys(localEdits).length > 0
  const hasProjectOverrides = Object.keys(projectOverrides).length > 0

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-600 text-white'
          : toast.type === 'warning' ? 'bg-amber-500 text-white'
          : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Default Prompt Editor</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Inspect and customize the AI instructions that wrap each analysis block type. Changes here do not affect the prompts you write in individual blocks — they control the surrounding structure.
            </p>
          </div>

          {/* Scope toggle */}
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-1">
            <button
              onClick={() => setScope('project')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                scope === 'project'
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Individual Project System Prompts
            </button>
            <button
              onClick={() => setScope('global')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                scope === 'global'
                  ? 'bg-amber-600 text-white'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Global Defaults
            </button>
          </div>
        </div>

        {/* Scope banners */}
        {scope === 'global' && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 leading-relaxed">
            <svg className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span>You are editing <strong>Global Defaults</strong> — these apply to all projects that have not set their own individual project system prompts for a given template. Changes here will take effect on the next analysis run for any affected project.</span>
          </div>
        )}
        {scope === 'project' && (
          <div className="mt-3 flex items-start justify-between gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 leading-relaxed">
            <span>
              {hasProjectOverrides
                ? 'This project has individual system prompts active. They override the global defaults only for the specific templates you have customized — everything else still uses the global defaults.'
                : 'This project is currently using the global defaults for all templates. You can customize any template below to create prompts specific to this project without affecting others.'}
            </span>
            {hasProjectOverrides && (
              <button
                onClick={handleResetProjectOverrides}
                className="shrink-0 px-2 py-1 bg-indigo-100 hover:bg-indigo-200 border border-indigo-300 rounded text-indigo-900 transition-colors"
              >
                Reset to Global Defaults
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Block type sidebar */}
        <div className="w-48 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col py-2">
          {BLOCK_TYPES.map((bt) => (
            <button
              key={bt.id}
              onClick={() => setActiveBlockType(bt.id)}
              className={`text-left px-4 py-2.5 text-xs font-medium transition-colors ${
                activeBlockType === bt.id
                  ? 'bg-indigo-50 text-indigo-700 border-r-2 border-indigo-600'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              {bt.label}
            </button>
          ))}
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Task sub-tabs */}
          <div className="shrink-0 flex border-b border-gray-200 bg-white px-4 pt-2 gap-1">
            {currentSchema?.tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => setActiveTask(task.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${
                  activeTask === task.id
                    ? 'bg-white border border-b-white border-gray-200 text-indigo-700 -mb-px z-10'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {task.label}
              </button>
            ))}
          </div>

          {/* Task editor */}
          <div className="flex-1 overflow-auto p-6">
            {currentTask ? (
              <TaskEditor
                blockType={activeBlockType}
                task={currentTask}
                globalDefaults={globalDefaults}
                projectOverrides={scope === 'project' ? projectOverrides : {}}
                localEdits={localEdits}
                onEdit={handleEdit}
                onResetTask={handleResetTask}
              />
            ) : (
              <div className="text-sm text-gray-400">Select a task above.</div>
            )}
          </div>

          {/* Footer save bar */}
          <div className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-gray-50">
            <span className="text-xs text-gray-500">
              {hasLocalEdits
                ? 'You have unsaved changes.'
                : 'No unsaved changes.'}
            </span>
            <button
              onClick={handleSave}
              disabled={saving || !hasLocalEdits}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : scope === 'project' ? 'Save to This Project' : 'Save to Global Defaults'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
