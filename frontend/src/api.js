import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

// Projects
export const listProjects = () => api.get('/projects/')
export const createProject = (data) => api.post('/projects/', data)
export const getProject = (id) => api.get(`/projects/${id}`)
export const updateProject = (id, data) => api.put(`/projects/${id}`, data)
export const deleteProject = (id) => api.delete(`/projects/${id}`)
export const saveProject = (id) => api.post(`/projects/${id}/save`)

// Documents
export const uploadDocument = (projectId, file, folderName = null, batch = false) => {
  const formData = new FormData()
  formData.append('file', file)
  if (folderName) formData.append('folder_name', folderName)
  if (batch) formData.append('batch', 'true')
  return api.post(`/documents/${projectId}/upload`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
export const finalizeDocuments = (projectId, count) =>
  api.post(`/documents/${projectId}/finalize`, { count })
export const listDocuments = (projectId) => api.get(`/documents/${projectId}/list`)
export const listFolders = (projectId) => api.get(`/documents/${projectId}/folders`)
export const getParsedDoc = (projectId, docIndex) => api.get(`/documents/${projectId}/parsed/${docIndex}`)
export const deleteDocument = (projectId, docIndex) => api.delete(`/documents/${projectId}/${docIndex}`)
export const deleteFolder = (projectId, folderName) => api.delete(`/documents/${projectId}/folder/${encodeURIComponent(folderName)}`)
export const getUnitPreview = (projectId, unitId) => api.get(`/documents/${projectId}/unit/${unitId}`)
export const getDocumentColumns = (projectId) => api.get(`/documents/${projectId}/columns`)
export const reparseColumn = (projectId, docIndex, columnName, method, delimiters) =>
  api.post(`/documents/${projectId}/${docIndex}/reparse-column`, { column_name: columnName, method, delimiters })
export const resetColumnGranularity = (projectId, docIndex, columnName) =>
  api.delete(`/documents/${projectId}/${docIndex}/reparse-column`, { data: { column_name: columnName } })
export const ensureColumnReparsed = (projectId, { sourceType, sourceDocIndex, sourceFolderName, columnName, method, delimiters }) =>
  api.post(`/documents/${projectId}/ensure-column-reparsed`, {
    source_type: sourceType,
    source_doc_index: sourceDocIndex,
    source_folder_name: sourceFolderName,
    column_name: columnName,
    method,
    delimiters,
  })

// Flow
export const getFlow = (projectId) => api.get(`/flow/${projectId}`)
export const saveFlow = (projectId, flowData) => api.put(`/flow/${projectId}`, flowData)
export const validateFlow = (projectId) => api.post(`/flow/${projectId}/validate`)

// Analysis
export const runAnalysis = (projectId, blockId) => api.post(`/analysis/${projectId}/run`, { block_id: blockId })
export const stopAnalysis = (projectId) => api.post(`/analysis/${projectId}/stop`)
export const resumeAnalysis = (projectId, blockId) => api.post(`/analysis/${projectId}/resume`, { block_id: blockId })
export const getAnalysisStatus = (projectId) => api.get(`/analysis/${projectId}/status`)
export const getBlockFiles = (projectId, blockId) => api.get(`/analysis/${projectId}/block-files/${blockId}`)
export const getBlockState = (projectId, blockId) => api.get(`/analysis/${projectId}/block-state/${blockId}`)
export const clearBlockState = (projectId, blockId) => api.post(`/analysis/${projectId}/block-clear/${blockId}`)
export const openPath = (projectId, relativePath) => api.post(`/analysis/${projectId}/open-path`, { relative_path: relativePath })

// Alignment (new per-block workflow)
export const getAlignmentBlocks = (projectId) => api.get(`/alignment/${projectId}/blocks`)
export const generateAlignmentSample = (projectId, blockId, sampleSize) =>
  api.post(`/alignment/${projectId}/generate-sample`, { block_id: blockId, sample_size: sampleSize })
export const generateThemeSample = (projectId, blockId, sampleSize) =>
  api.post(`/alignment/${projectId}/generate-theme-sample`, { block_id: blockId, sample_size: sampleSize })
export const generateSingleOutputTest = (projectId, blockId) =>
  api.post(`/alignment/${projectId}/generate-single-output-test`, { block_id: blockId })
export const saveAlignmentTest = (projectId, testData) =>
  api.post(`/alignment/${projectId}/save-test`, testData)
export const saveSingleLabel = (projectId, testId, unitId, labelData) =>
  api.post(`/alignment/${projectId}/save-single-label`, { test_id: testId, unit_id: unitId, label_data: labelData })
export const runAlignmentComparison = (projectId, testId) =>
  api.post(`/alignment/${projectId}/run-comparison`, { test_id: testId })
export const getCurrentDraftTest = (projectId, blockId) =>
  api.get(`/alignment/${projectId}/current-test/${blockId}`)
export const getAlignmentTests = (projectId, blockId) =>
  api.get(`/alignment/${projectId}/tests/${blockId}`)
export const getAlignmentTest = (projectId, testId) =>
  api.get(`/alignment/${projectId}/test/${testId}`)
export const deleteAlignmentTest = (projectId, testId) =>
  api.delete(`/alignment/${projectId}/test/${testId}?confirm=true`)
export const downloadAlignmentTest = (projectId, testId) =>
  api.get(`/alignment/${projectId}/test/${testId}/download`, { responseType: 'blob' })
export const downloadAlignmentCsv = (projectId, testId) =>
  api.get(`/alignment/${projectId}/test/${testId}/export.csv`, { responseType: 'blob' })
export const downloadAlignmentReport = (projectId, testId, format = 'md') =>
  api.get(`/alignment/${projectId}/test/${testId}/report?format=${format}`, { responseType: 'blob' })
// Human rationale + rater reliability
export const saveRationale = (projectId, testId, body) =>
  api.post(`/alignment/${projectId}/test/${testId}/rationale`, body)
export const startReliability = (projectId, testId) =>
  api.post(`/alignment/${projectId}/test/${testId}/reliability/start`)
export const saveReliabilityLabel = (projectId, testId, unitId, labelData) =>
  api.post(`/alignment/${projectId}/test/${testId}/reliability/label`, { unit_id: unitId, label_data: labelData })
export const computeReliability = (projectId, testId) =>
  api.post(`/alignment/${projectId}/test/${testId}/reliability/compute`)
// Automated prompt optimization
export const getOptimizationModels = (projectId) => api.get(`/alignment/${projectId}/optimizations/models`)
export const estimateOptimization = (projectId, testId, config) =>
  api.post(`/alignment/${projectId}/optimizations/estimate`, { test_id: testId, config })
export const startOptimization = (projectId, blockId, testId, config) =>
  api.post(`/alignment/${projectId}/optimizations`, { block_id: blockId, test_id: testId, config })
export const listOptimizations = (projectId, blockId) =>
  api.get(`/alignment/${projectId}/optimizations`, { params: { block_id: blockId } })
export const getOptimization = (projectId, jobId) => api.get(`/alignment/${projectId}/optimizations/${jobId}`)
export const getOptimizationCandidate = (projectId, jobId, cid) =>
  api.get(`/alignment/${projectId}/optimizations/${jobId}/candidates/${cid}`)
export const stopOptimization = (projectId, jobId) => api.post(`/alignment/${projectId}/optimizations/${jobId}/stop`)
export const resumeOptimization = (projectId, jobId) => api.post(`/alignment/${projectId}/optimizations/${jobId}/resume`)
export const getOptimizationDisagreements = (projectId, jobId) =>
  api.get(`/alignment/${projectId}/optimizations/${jobId}/disagreements`)
export const applyOptimizationCandidate = (projectId, jobId, cid, edits) =>
  api.post(`/alignment/${projectId}/optimizations/${jobId}/candidates/${cid}/apply`, { edits })
export const downloadOptimizationReport = (projectId, jobId, format = 'md') =>
  api.get(`/alignment/${projectId}/optimizations/${jobId}/report?format=${format}`, { responseType: 'blob' })
export const updateBlockPrompts = (projectId, blockId, prompts) =>
  api.put(`/alignment/${projectId}/block-prompts/${blockId}`, prompts)

// LLM
export const getOllamaStatus = () => api.get('/llm/status')
export const listModels = () => api.get('/llm/models')
export const testModel = (model, prompt) => api.post('/llm/test', { model, prompt })

// CSV Data
export const getCsvData = (projectId, blockId, filename) => api.get(`/csv/${projectId}/block/${blockId}/${filename}`)
export const editCsvRow = (projectId, blockId, filename, rowIndex, updates) =>
  api.put(`/csv/${projectId}/block/${blockId}/${filename}/edit`, { row_index: rowIndex, updates })

// Reports
export const generateReport = (projectId) => api.post(`/reports/${projectId}/generate`)
export const listReports = (projectId) => api.get(`/reports/${projectId}/list`)
export const viewReport = (projectId, filename) => api.get(`/reports/${projectId}/view/${filename}`)

// Packages
export const exportProject = (id, opts) =>
  api.post(`/packages/${id}/export`, opts, { responseType: 'blob' })

export const importProject = (formData) =>
  api.post('/packages/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })

// About
export const getAboutPage = () => api.get('/about/')

// Settings
export const getProviders = () => api.get('/settings/providers')
export const saveProviderKey = (providerId, data) => api.put(`/settings/providers/${providerId}/key`, data)
export const deleteProviderKey = (providerId) => api.delete(`/settings/providers/${providerId}/key`)
export const getProviderModels = (providerId) => api.get(`/settings/providers/${providerId}/models`)
export const setActiveModel = (provider, model) => api.put('/settings/active-model', { provider, model })
export const getSettingsHealth = () => api.get('/settings/health')
// Hardware & performance (unified-memory aware)
export const getHardware = (refresh = false) => api.get('/settings/hardware', { params: refresh ? { refresh: 1 } : {} })
export const getHardwareFit = (params = {}) => api.get('/settings/hardware/fit', { params })
export const getOllamaServer = () => api.get('/settings/ollama-server')
export const applyOllamaServer = (settings) => api.post('/settings/ollama-server/apply', { settings })
export const runBenchmark = (model) => api.post('/settings/benchmark', { model })
export const getOllamaContext = () => api.get('/settings/ollama-context')
export const setOllamaContext = (numCtx) => api.put('/settings/ollama-context', { num_ctx: numCtx })

// Feedback / crash reports
export const getFeedbackConfig = () => api.get('/settings/feedback-config')
export const submitCrashReport = async (crashData) => {
  const res = await api.get('/settings/feedback-config')
  const config = res.data
  if (!config.crash_report_url) return
  return fetch(config.crash_report_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...crashData, app_version: config.app_version }),
  })
}
export const submitSuggestion = async (data) => {
  const res = await api.get('/settings/feedback-config')
  const config = res.data
  if (!config.suggestion_url) return
  return fetch(config.suggestion_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...data, app_version: config.app_version }),
  })
}

// llmfit
export const getLlmfitStatus = () => api.get('/llmfit/status')
export const runLlmfitScan = () => api.post('/llmfit/scan')
export const pullOllamaModel = (model) => api.post('/llmfit/pull', { model })
export const installLlmfit = () => api.post('/llmfit/install')

// Prompt Templates
export const getPromptDefaults = () => api.get('/prompts/defaults')
export const savePromptDefaults = (data) => api.put('/prompts/defaults', data)
export const getProjectPromptOverrides = (projectId) => api.get(`/prompts/${projectId}/overrides`)
export const saveProjectPromptOverrides = (projectId, data) => api.put(`/prompts/${projectId}/overrides`, data)
export const resetProjectPromptOverrides = (projectId) => api.delete(`/prompts/${projectId}/overrides`)
export const getEffectivePromptTemplates = (projectId) => api.get(`/prompts/${projectId}/effective`)

export default api
