import { useEffect, useRef } from 'react'
import { saveProject } from '../api'

const AUTOSAVE_INTERVAL = 5 * 60 * 1000  // 5 minutes
const IDLE_TIMEOUT = 15 * 60 * 1000       // 15 minutes

export default function useAutosave(projectId) {
  const lastActivityRef = useRef(Date.now())
  const hasChangesRef = useRef(false)

  useEffect(() => {
    function updateActivity() {
      lastActivityRef.current = Date.now()
      hasChangesRef.current = true
    }

    window.addEventListener('mousemove', updateActivity)
    window.addEventListener('keydown', updateActivity)

    const timer = setInterval(async () => {
      const idle = Date.now() - lastActivityRef.current
      if (hasChangesRef.current && idle < IDLE_TIMEOUT && projectId) {
        try {
          await saveProject(projectId)
          hasChangesRef.current = false
        } catch (err) {
          console.error('Autosave failed:', err)
        }
      }
    }, AUTOSAVE_INTERVAL)

    return () => {
      window.removeEventListener('mousemove', updateActivity)
      window.removeEventListener('keydown', updateActivity)
      clearInterval(timer)
    }
  }, [projectId])
}
