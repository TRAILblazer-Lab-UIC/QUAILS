import { useEffect, useRef, useState } from 'react'

function groupUnitsByStructure(units) {
  const hasStructure = units.some(
    u => u.section_index !== undefined || u.para_index !== undefined || u.is_header
  )

  if (!hasStructure) {
    // Old format (no hierarchy metadata): flat display in one group
    return [{ sectionIndex: 0, heading: null, paragraphs: [{ paraIndex: 0, units }] }]
  }

  const sectionOrder = []
  const sectionMap = {}

  for (const unit of units) {
    const secIdx = unit.section_index ?? 0
    const paraIdx = unit.para_index ?? 0

    if (!sectionMap[secIdx]) {
      sectionMap[secIdx] = { sectionIndex: secIdx, heading: null, paraMap: {} }
      sectionOrder.push(secIdx)
    }
    const sec = sectionMap[secIdx]

    if (unit.is_header) {
      sec.heading = unit
    } else {
      if (!sec.paraMap[paraIdx]) {
        sec.paraMap[paraIdx] = { paraIndex: paraIdx, units: [] }
      }
      sec.paraMap[paraIdx].units.push(unit)
    }
  }

  return sectionOrder.map(secIdx => {
    const sec = sectionMap[secIdx]
    return {
      sectionIndex: sec.sectionIndex,
      heading: sec.heading,
      paragraphs: Object.values(sec.paraMap).sort((a, b) => a.paraIndex - b.paraIndex),
    }
  })
}

export default function TextViewer({
  parsedData,
  selectedUnit,
  hoveredUnitId,
  onHoverUnit,
  highlightMode = 'paragraph',
}) {
  const containerRef = useRef(null)
  const [localHovered, setLocalHovered] = useState(null)

  // Whichever source set the hover takes precedence; units panel hover (prop) wins over text hover
  const effectiveHovered = hoveredUnitId || localHovered

  useEffect(() => {
    if (selectedUnit && containerRef.current) {
      const el = containerRef.current.querySelector(`[data-unit-id="${selectedUnit}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [selectedUnit])

  if (!parsedData || !parsedData.units) {
    return <div className="text-gray-400 p-4">No parsed content available</div>
  }

  const units = parsedData.units
  const grouped = groupUnitsByStructure(units)
  const hasStructure = grouped.length > 1 || grouped[0]?.heading || grouped[0]?.paragraphs.length > 1

  // Build a lookup for the hovered unit's coords
  const unitMap = {}
  for (const u of units) unitMap[u.unit_id] = u
  const hUnit = effectiveHovered ? unitMap[effectiveHovered] : null

  function handleUnitEnter(unit) {
    setLocalHovered(unit.unit_id)
    if (onHoverUnit) onHoverUnit(unit.unit_id)
  }
  function handleUnitLeave() {
    setLocalHovered(null)
    if (onHoverUnit) onHoverUnit(null)
  }

  function isParaHighlighted(secIdx, paraIdx) {
    if (!hUnit || highlightMode !== 'paragraph') return false
    return (hUnit.section_index ?? 0) === secIdx && (hUnit.para_index ?? 0) === paraIdx
  }
  function isSectionHighlighted(secIdx) {
    if (!hUnit || highlightMode !== 'section') return false
    return (hUnit.section_index ?? 0) === secIdx
  }

  // For flat (old format) documents: just render units in a simple list
  if (!hasStructure) {
    return (
      <div ref={containerRef} className="space-y-1">
        {units.map(unit => (
          <div
            key={unit.unit_id}
            data-unit-id={unit.unit_id}
            onMouseEnter={() => handleUnitEnter(unit)}
            onMouseLeave={handleUnitLeave}
            className={`p-2 rounded text-sm transition-colors ${
              selectedUnit === unit.unit_id
                ? 'bg-amber-50 border border-amber-200 text-gray-900'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <span className="text-gray-400 font-mono text-[10px] mr-2">{unit.unit_id}</span>
            {unit.text}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="prose prose-sm max-w-none">
      {grouped.map(section => (
        <div
          key={section.sectionIndex}
          className={`transition-colors rounded-sm ${
            isSectionHighlighted(section.sectionIndex) ? 'bg-amber-50' : ''
          }`}
        >
          {/* Section header */}
          {section.heading && (
            <div
              data-unit-id={section.heading.unit_id}
              onMouseEnter={() => handleUnitEnter(section.heading)}
              onMouseLeave={handleUnitLeave}
              className={`my-3 cursor-default ${
                selectedUnit === section.heading.unit_id ? 'bg-amber-100 rounded px-1' : ''
              }`}
            >
              {section.heading.heading_level === 1 ? (
                <h2 className="text-base font-bold text-gray-900 border-b border-gray-200 pb-1">
                  {section.heading.text}
                </h2>
              ) : section.heading.heading_level === 2 ? (
                <h3 className="text-sm font-bold text-gray-800">
                  {section.heading.text}
                </h3>
              ) : (
                <h4 className="text-sm font-semibold text-gray-700">
                  {section.heading.text}
                </h4>
              )}
            </div>
          )}

          {/* Paragraphs */}
          {section.paragraphs.map(para => (
            <div
              key={para.paraIndex}
              className={`mb-3 px-1 py-0.5 rounded transition-colors ${
                isParaHighlighted(section.sectionIndex, para.paraIndex) ? 'bg-amber-50' : ''
              }`}
            >
              {para.units.map(unit => (
                <span
                  key={unit.unit_id}
                  data-unit-id={unit.unit_id}
                  onMouseEnter={() => handleUnitEnter(unit)}
                  onMouseLeave={handleUnitLeave}
                  className={`text-sm cursor-default transition-colors ${
                    selectedUnit === unit.unit_id
                      ? 'bg-amber-200 text-amber-900 rounded px-0.5'
                      : 'text-gray-700'
                  }`}
                >
                  {unit.text}{' '}
                </span>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
