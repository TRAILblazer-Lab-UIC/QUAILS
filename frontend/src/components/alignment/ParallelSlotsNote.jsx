import { useEffect, useState } from 'react'
import { getOllamaServer } from '../../api'

/** Warns when Throughput mode asks for more parallel cases than Ollama's server will run at once. */
export default function ParallelSlotsNote({ slots }) {
  const [serverSlots, setServerSlots] = useState(undefined)
  useEffect(() => {
    if (slots <= 1) return
    getOllamaServer().then(res => {
      const v = (res.data.live || {}).OLLAMA_NUM_PARALLEL ?? (res.data.saved || {}).OLLAMA_NUM_PARALLEL
      setServerSlots(v != null ? Number(v) : null)
    }).catch(() => setServerSlots(null))
  }, [slots])
  if (slots <= 1 || serverSlots === undefined) return null
  if (serverSlots != null && serverSlots >= slots) return null
  return (
    <span className="text-amber-700">
      {serverSlots != null
        ? `Ollama is set to run ${serverSlots} request${serverSlots === 1 ? '' : 's'} at a time, so extra cases will just queue.`
        : "Ollama's parallel setting is unknown (its own default)."}
      {' '}Apply the throughput settings in AI Settings → Hardware &amp; performance.
    </span>
  )
}
