import { useState, useEffect, useCallback } from 'react'
import { getProject } from '../api'

export default function useProject(projectId) {
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await getProject(projectId)
      setProject(res.data)
    } catch (err) {
      console.error('Failed to load project:', err)
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    reload()
  }, [reload])

  return { project, loading, reload }
}
