import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  PSEUDOCODE_STAGES,
  type PseudocodeKey,
  type PseudocodeRunResult,
  type PseudoStep,
} from '../algorithms/pseudocode'

interface PseudocodePanelProps {
  stageKey: PseudocodeKey
  code: string
  isCustom: boolean
  driveLayer: boolean
  runResult: PseudocodeRunResult
  selectedStep: number | null
  onChangeCode: (code: string) => void
  onResetCode: () => void
  onToggleDriveLayer: (drive: boolean) => void
  onSelectStep: (stepIndex: number | null) => void
}

const KEYWORDS = new Set([
  'const',
  'let',
  'for',
  'of',
  'if',
  'else',
  'return',
  'while',
  'true',
  'false',
  'null',
  'undefined',
  'Infinity',
  'Math',
])

const PRIMITIVES = new Set([
  'step',
  'offset',
  'difference',
  'union',
  'intersect',
  'intersection',
  'unionAll',
  'ringsOf',
  'ringsToPolygons',
  'stitchRawSegments',
  'ringToWallLine',
  'extrusionLineSausages',
  'wallBandRegion',
  'computeGaps',
  'arachneInsets',
  'computeSkeleton',
  'pruneSkeleton',
  'skeletonPolylines',
  'beadWidth',
  'smoothWidths',
  'extractBeadRuns',
  'generateInfill',
  'groupFeaturesByOrder',
  'nearestVertex',
  'rotateRing',
  'weightedDistance',
  'endingDirection',
  'segmentInsideArea',
  'pathInsideArea',
  'combAlongBoundary',
  'polylineLength',
  'pointInPolygons',
  'dist',
])

function highlightCodeLine(line: string): ReactNode {
  const commentIdx = line.indexOf('//')
  if (commentIdx === 0 || line.trimStart().startsWith('//')) {
    return <span className="tok-comment">{line}</span>
  }
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line
  const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : ''

  const tokenRegex = /(`[^`]*`|'[^']*'|"[a-zA-Z0-9_.\s-]*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
  const parts: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  let k = 0
  while ((match = tokenRegex.exec(codePart)) !== null) {
    if (match.index > lastIdx) {
      parts.push(codePart.slice(lastIdx, match.index))
    }
    const tok = match[0]
    if (tok.startsWith("'") || tok.startsWith('"') || tok.startsWith('`')) {
      parts.push(
        <span key={k++} className="tok-str">
          {tok}
        </span>,
      )
    } else if (/^\d/.test(tok)) {
      parts.push(
        <span key={k++} className="tok-num">
          {tok}
        </span>,
      )
    } else if (tok === 'step') {
      parts.push(
        <span key={k++} className="tok-step">
          {tok}
        </span>,
      )
    } else if (KEYWORDS.has(tok)) {
      parts.push(
        <span key={k++} className="tok-kw">
          {tok}
        </span>,
      )
    } else if (PRIMITIVES.has(tok)) {
      parts.push(
        <span key={k++} className="tok-fn">
          {tok}
        </span>,
      )
    } else {
      parts.push(tok)
    }
    lastIdx = match.index + tok.length
  }
  if (lastIdx < codePart.length) {
    parts.push(codePart.slice(lastIdx))
  }
  if (commentPart) {
    parts.push(
      <span key="cmt" className="tok-comment">
        {commentPart}
      </span>,
    )
  }
  return parts
}

export function PseudocodePanel(props: PseudocodePanelProps) {
  const {
    stageKey,
    code,
    isCustom,
    driveLayer,
    runResult,
    selectedStep,
    onChangeCode,
    onResetCode,
    onToggleDriveLayer,
    onSelectStep,
  } = props

  const spec = PSEUDOCODE_STAGES[stageKey]
  const [editing, setEditing] = useState(false)
  const codeScrollRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => code.split('\n'), [code])

  // Map every 1-based line within [startLine, endLine] to the step(s) that execute that block.
  const lineBlockMap = useMemo(() => {
    const map = new Map<number, PseudoStep[]>()
    for (const s of runResult.steps) {
      for (let l = s.details.startLine; l <= s.details.endLine; l++) {
        const list = map.get(l)
        if (list) list.push(s)
        else map.set(l, [s])
      }
    }
    return map
  }, [runResult.steps])

  const activeStepObj =
    selectedStep !== null ? (runResult.steps[selectedStep] ?? null) : null

  // Auto-scroll the pseudocode viewer to the start of the highlighted code block when stepping.
  useEffect(() => {
    if (!activeStepObj || editing || !codeScrollRef.current) return
    const lineEl = codeScrollRef.current.querySelector(
      `[data-line="${activeStepObj.details.startLine}"]`,
    ) as HTMLElement | null
    if (lineEl) {
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [activeStepObj, editing])

  const handleRun = () => {
    onChangeCode(code)
  }

  const handleReset = () => {
    onResetCode()
  }

  const stepCount = runResult.steps.length
  const canPrev = stepCount > 0 && selectedStep !== null && selectedStep > 0
  const canNext =
    stepCount > 0 && (selectedStep === null ? true : selectedStep < stepCount - 1)

  const goPrev = () => {
    if (stepCount === 0) return
    if (selectedStep === null) onSelectStep(stepCount - 1)
    else if (selectedStep > 0) onSelectStep(selectedStep - 1)
  }

  const goNext = () => {
    if (stepCount === 0) return
    if (selectedStep === null) onSelectStep(0)
    else if (selectedStep < stepCount - 1) onSelectStep(selectedStep + 1)
  }

  return (
    <div className="pseudo-panel">
      <div className="pseudo-header">
        <div className="pseudo-title-row">
          <h3 className="doc-title" style={{ margin: 0 }}>
            {spec.title}
          </h3>
          <span className={`pseudo-status ${runResult.ok ? 'ok' : 'err'}`}>
            {runResult.ok
              ? `${runResult.steps.length} steps · ${runResult.runtimeMs.toFixed(1)} ms`
              : 'Runtime error'}
          </span>
        </div>
        <div className="pseudo-subtitle">{spec.subtitle}</div>
        <div className="pseudo-io">
          <div>
            <span className="io-label">IN</span> <code>{spec.inputsNote}</code>
          </div>
          <div>
            <span className="io-label">OUT</span> <code>{spec.returnsNote}</code>
          </div>
        </div>
      </div>

      <div className="pseudo-toolbar">
        <label
          className="pseudo-drive-toggle"
          title="Run this pseudocode to generate the 2D layer slice data on the canvas"
        >
          <input
            type="checkbox"
            checked={driveLayer}
            onChange={(e) => onToggleDriveLayer(e.target.checked)}
          />
          <span>Drive layer slice data</span>
        </label>
        <div className="pseudo-actions">
          <button
            type="button"
            className={`btn btn-xs${editing ? ' active' : ''}`}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Done editing' : 'Edit code'}
          </button>
          {editing && (
            <button
              type="button"
              className="btn btn-xs active"
              onClick={handleRun}
              title="Execute edited pseudocode (Cmd/Ctrl+Enter)"
            >
              ▶ Run
            </button>
          )}
          {(isCustom || code !== spec.defaultCode) && (
            <button type="button" className="btn btn-xs" onClick={handleReset}>
              ↺ Reset
            </button>
          )}
        </div>
      </div>

      {!runResult.ok && runResult.error && (
        <div className="pseudo-error">
          <strong>Execution Error:</strong> {runResult.error}
        </div>
      )}

      {/* Step-by-step checkpoints */}
      <div className="pseudo-steps-box">
        <div className="pseudo-steps-header">
          <span className="pseudo-steps-title">
            1. Select a step ({selectedStep === null ? 'Showing all' : `Step ${selectedStep + 1} of ${stepCount}`})
          </span>
          <div className="pseudo-step-nav">
            <button
              type="button"
              className="btn btn-xs"
              disabled={!canPrev}
              onClick={goPrev}
              title="Previous algorithm step"
            >
              ◀ Prev
            </button>
            <button
              type="button"
              className="btn btn-xs"
              disabled={!canNext}
              onClick={goNext}
              title="Next algorithm step"
            >
              Next ▶
            </button>
            <button
              type="button"
              className={`btn btn-xs${selectedStep === null ? ' active' : ''}`}
              onClick={() => onSelectStep(null)}
              title="Show full layer output"
            >
              All
            </button>
          </div>
        </div>
        <div className="pseudo-steps-list">
          {runResult.steps.map((s) => {
            const active = selectedStep === s.index
            const rangeStr =
              s.details.startLine === s.details.endLine
                ? `L${s.details.startLine}`
                : `L${s.details.startLine}–${s.details.endLine}`
            return (
              <button
                key={s.index}
                type="button"
                className={`pseudo-step-item${active ? ' active' : ''}`}
                onClick={() => onSelectStep(active ? null : s.index)}
              >
                <span className="step-num">S{s.index + 1}</span>
                <span className="step-main">
                  <span className="step-label">{s.label}</span>
                  <span className="step-note">{s.note}</span>
                </span>
                <span className="step-line" title={`Computed by code lines ${s.details.startLine} to ${s.details.endLine}`}>
                  {rangeStr}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Step Explanation & Significance Inspector */}
      {activeStepObj ? (
        <div className="step-explain-card">
          <div className="step-explain-header">
            <span className="step-explain-badge">
              S{activeStepObj.index + 1} · Lines {activeStepObj.details.startLine}–{activeStepObj.details.endLine}
            </span>
            <span className="step-explain-algo">{activeStepObj.details.algorithm}</span>
          </div>

          <div className="step-explain-section">
            <div className="step-explain-label">What this code block does</div>
            <div className="step-explain-body">{activeStepObj.details.whatItDoes}</div>
          </div>

          {(activeStepObj.details.paramsUsed.length > 0 ||
            activeStepObj.details.functionsCalled.length > 0) && (
            <div className="step-explain-section">
              <div className="step-explain-label">Parameters &amp; functions in Lines {activeStepObj.details.startLine}–{activeStepObj.details.endLine}</div>
              {activeStepObj.details.paramsUsed.length > 0 && (
                <div className="step-param-chips">
                  {activeStepObj.details.paramsUsed.map((p) => (
                    <span key={p.name} className="step-param-chip">
                      <code>{p.name}</code> = <strong>{p.value}</strong>
                    </span>
                  ))}
                </div>
              )}
              {activeStepObj.details.functionsCalled.length > 0 && (
                <ul className="step-fn-list">
                  {activeStepObj.details.functionsCalled.map((fn) => (
                    <li key={fn.name}>
                      <code>{fn.name}</code> — {fn.description}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="step-explain-section">
            <div className="step-explain-label">Data produced &amp; why it matters</div>
            <div className="step-data-metrics">{activeStepObj.details.dataMetrics}</div>
            <div className="step-explain-body">{activeStepObj.details.significance}</div>
          </div>
        </div>
      ) : (
        <div className="step-explain-hint">
          Click any step <strong>S1–S{stepCount}</strong> above (or click any <strong>S#</strong> code block below) to highlight its exact lines of code, see the algorithm &amp; parameters used, and inspect the intermediate geometry on the canvas.
        </div>
      )}

      {/* Commented Pseudocode Viewer / Editor */}
      <div className="pseudo-code-section">
        <div className="pseudo-code-header">
          <span>
            2. Stage Pseudocode{' '}
            {activeStepObj && (
              <strong className="code-range-active">
                (Highlighting S{activeStepObj.index + 1}: Lines {activeStepObj.details.startLine}–{activeStepObj.details.endLine})
              </strong>
            )}
          </span>
          <span className="pseudo-code-sub">Click any block to inspect</span>
        </div>
        <div className="pseudo-code-wrap" ref={codeScrollRef}>
          {editing ? (
            <div className="pseudo-editor-container">
              <textarea
                className="pseudo-textarea"
                value={code}
                spellCheck={false}
                onChange={(e) => onChangeCode(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleRun()
                  }
                }}
              />
            </div>
          ) : (
            <div className={`pseudo-code-lines${activeStepObj ? ' has-active-step' : ''}`}>
              {lines.map((lineText, i) => {
                const lineNo = i + 1
                const blockSteps = lineBlockMap.get(lineNo)
                const primaryStep = blockSteps?.[0]
                const isInActiveBlock =
                  activeStepObj !== null &&
                  lineNo >= activeStepObj.details.startLine &&
                  lineNo <= activeStepObj.details.endLine
                const isBlockStart =
                  primaryStep !== undefined && primaryStep.details.startLine === lineNo
                const isStepCallLine =
                  blockSteps !== undefined && blockSteps.some((s) => s.line === lineNo)

                return (
                  <div
                    key={lineNo}
                    data-line={lineNo}
                    className={[
                      'pseudo-line',
                      blockSteps ? 'in-step-block' : '',
                      isInActiveBlock ? 'active-block-line' : '',
                      isStepCallLine ? 'step-call-line' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (!blockSteps || blockSteps.length === 0) return
                      const idx =
                        activeStepObj && blockSteps.some((s) => s.index === activeStepObj.index)
                          ? null
                          : blockSteps[0].index
                      onSelectStep(idx)
                    }}
                  >
                    <span className="pseudo-gutter">
                      {isBlockStart && primaryStep ? (
                        <span
                          className="step-block-tag"
                          title={`Step ${primaryStep.index + 1}: ${primaryStep.label} (Lines ${primaryStep.details.startLine}–${primaryStep.details.endLine})`}
                        >
                          {blockSteps && blockSteps.length > 1
                            ? `S${blockSteps[0].index + 1}..${blockSteps[blockSteps.length - 1].index + 1}`
                            : `S${primaryStep.index + 1}`}
                        </span>
                      ) : isStepCallLine ? (
                        <span className="step-dot" title="step() checkpoint emitted here">
                          ●
                        </span>
                      ) : null}
                      <span className="line-num">{lineNo}</span>
                    </span>
                    <span className="pseudo-code-text">{highlightCodeLine(lineText)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
