import { useRef, useState } from 'react'

export default function HelpLabel({ label, help }) {
  const iconRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0, above: true })
  const [visible, setVisible] = useState(false)

  function handleEnter() {
    const icon = iconRef.current
    if (!icon) return

    const iconRect = icon.getBoundingClientRect()
    const tipW = 224 // w-56 = 14rem = 224px
    const tipH = 80  // estimated; will self-correct via clamping

    // Vertical: prefer above, flip below if not enough room
    const above = iconRect.top - tipH - 6 >= 0

    // Horizontal: center on icon, then clamp to viewport
    const iconCenterX = iconRect.left + iconRect.width / 2
    const pad = 8
    let left = iconCenterX - tipW / 2
    if (left < pad) left = pad
    else if (left + tipW > window.innerWidth - pad) left = window.innerWidth - pad - tipW

    const top = above
      ? iconRect.top - 4
      : iconRect.bottom + 4

    setPos({ top, left, above })
    setVisible(true)
  }

  function handleLeave() {
    setVisible(false)
  }

  return (
    <span className="text-gray-600 text-xs inline-flex items-center gap-1">
      {label}
      <span
        className="relative cursor-help"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <span ref={iconRef} className="hover:brightness-125 transition-all">ℹ️</span>
        {visible && (
          <span
            className="fixed w-56 px-2 py-1.5 text-xs text-slate-100 bg-gray-900 border border-gray-600 rounded shadow-lg z-[100] whitespace-normal leading-snug pointer-events-none"
            style={{
              left: `${pos.left}px`,
              ...(pos.above
                ? { bottom: `${window.innerHeight - pos.top}px` }
                : { top: `${pos.top}px` }),
            }}
          >
            {help}
          </span>
        )}
      </span>
    </span>
  )
}
