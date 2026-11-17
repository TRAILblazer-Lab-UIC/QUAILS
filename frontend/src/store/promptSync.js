// Shared client-side state that keeps the Analysis Builder (FlowEditor),
// the Alignment tab, and the Default Prompt Editor in lockstep.
//
// - Block data: FlowEditor stays the single *writer to disk* for flow.json. It
//   publishes every analysis block's data here (`blocks`) so Alignment can
//   read it live, and applies `patchBlock()` edits made from Alignment to its
//   canonical node state — whose existing debounced autosave then persists it.
// - Templates: global defaults + this project's overrides live here; the
//   Default Prompt Editor and the Alignment tab both read/edit them, and
//   project-override edits are autosaved (debounced) from here.
import { create } from 'zustand'
import {
  getPromptDefaults, getProjectPromptOverrides, saveProjectPromptOverrides,
} from '../api'

let overridesTimer = null
let flowSaver = null // registered by FlowEditor: () => Promise

export const usePromptSync = create((set, get) => ({
  // ---- block data ----
  blocks: {},                       // blockId -> node.data (published by FlowEditor)
  blockPatch: { rev: 0, blockId: null, patch: null },

  publishBlocks: (blocks) => set({ blocks }),

  // Edit from Alignment: update instantly for readers, tell FlowEditor to apply it.
  patchBlock: (blockId, patch) => set((s) => ({
    blocks: { ...s.blocks, [blockId]: { ...(s.blocks[blockId] || {}), ...patch } },
    blockPatch: { rev: s.blockPatch.rev + 1, blockId, patch },
  })),

  registerFlowSaver: (fn) => { flowSaver = fn },
  flushFlow: async () => { if (flowSaver) await flowSaver() },

  // ---- prompt templates ----
  templatesProjectId: null,
  globalDefaults: {},
  projectOverrides: {},
  overridesStatus: 'idle',          // idle | saving | saved | error

  loadTemplates: async (projectId, { force = false } = {}) => {
    if (!force && get().templatesProjectId === projectId) return
    set({ templatesProjectId: projectId })
    try {
      const [defRes, ovRes] = await Promise.all([
        getPromptDefaults(),
        getProjectPromptOverrides(projectId),
      ])
      if (get().templatesProjectId !== projectId) return
      set({ globalDefaults: defRes.data || {}, projectOverrides: ovRes.data || {} })
    } catch (err) {
      console.error('Failed to load prompt templates:', err)
      set({ templatesProjectId: null })
    }
  },

  setGlobalDefaults: (next) => set((s) => ({
    globalDefaults: typeof next === 'function' ? next(s.globalDefaults) : next,
  })),

  // Update in memory immediately (all readers see it). Pass { save: true } to
  // also autosave to disk after a short pause.
  setProjectOverrides: (next, { save = false } = {}) => {
    set((s) => ({
      projectOverrides: typeof next === 'function' ? next(s.projectOverrides) : next,
      overridesStatus: save ? 'saving' : s.overridesStatus,
    }))
    if (save) get().scheduleOverridesSave()
  },

  scheduleOverridesSave: () => {
    clearTimeout(overridesTimer)
    overridesTimer = setTimeout(() => { get().flushOverrides() }, 1000)
  },

  flushOverrides: async () => {
    clearTimeout(overridesTimer)
    overridesTimer = null
    const { templatesProjectId: pid, projectOverrides } = get()
    if (!pid || get().overridesStatus !== 'saving') return
    try {
      await saveProjectPromptOverrides(pid, projectOverrides)
      set({ overridesStatus: 'saved' })
    } catch (err) {
      console.error('Failed to save prompt overrides:', err)
      set({ overridesStatus: 'error' })
    }
  },
}))
