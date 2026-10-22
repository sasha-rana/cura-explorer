import { useEffect, useMemo, useRef, useState } from 'react'
import type { OrderedMove, Polyline } from '../algorithms/types'

interface AnimateControlsProps {
  moves: OrderedMove[]
  printSpeed: number // microns/s
  travelSpeed: number // microns/s
  /** Called with the current distance along the path, or null when inactive. */
  onProgress: (dist: number | null) => void
}

/**
 * Virtual nozzle: walks the ordered moves in real time at the configured
 * print/travel speeds (times the speed multiplier), reporting the distance
 * along the whole path so the canvas can draw printed vs remaining.
 */
export function AnimateControls(props: AnimateControlsProps) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [t, setT] = useState(0) // virtual seconds

  // Cumulative (time, distance) per move.
  const timeline = useMemo(() => {
    const segs: { t0: number; d0: number; dur: number; len: number }[] = []
    let time = 0
    let dist = 0
    for (const move of props.moves) {
      const line = move.line
      let len = 0
      const pts: Polyline =
        line.length > 0 && 'p' in line[0]
          ? (line as { p: { x: number; y: number } }[]).map((j) => j.p)
          : (line as Polyline)
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      }
      const v = move.kind === 'extrusion' ? props.printSpeed : props.travelSpeed
      const dur = len / Math.max(1, v)
      segs.push({ t0: time, d0: dist, dur, len })
      time += dur
      dist += len
    }
    return { segs, totalTime: time, totalDist: dist }
  }, [props.moves, props.printSpeed, props.travelSpeed])

  const distAt = (time: number): number => {
    if (timeline.totalTime <= 0) return 0
    const tt = Math.min(time, timeline.totalTime)
    const seg =
      timeline.segs.find((s) => tt <= s.t0 + s.dur) ?? timeline.segs[timeline.segs.length - 1]
    if (!seg) return 0
    return seg.d0 + (seg.dur > 0 ? ((tt - seg.t0) / seg.dur) * seg.len : 0)
  }

  const onProgressRef = useRef(props.onProgress)
  onProgressRef.current = props.onProgress
  const distAtRef = useRef(distAt)
  distAtRef.current = distAt

  // Report progress whenever t or the path changes.
  useEffect(() => {
    onProgressRef.current(distAtRef.current(t))
  }, [t, timeline])

  // Stop reporting when unmounted.
  useEffect(() => () => onProgressRef.current(null), [])

  // Playback loop.
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speedRef.current
      last = now
      setT((prev) => {
        const next = prev + dt
        if (next >= timeline.totalTime) {
          playingRef.current = false
          setPlaying(false)
          return timeline.totalTime
        }
        return next
      })
      if (playingRef.current) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timeline.totalTime])

  const progress = timeline.totalTime > 0 ? t / timeline.totalTime : 0

  return (
    <div className="animate-controls">
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (!playing && t >= timeline.totalTime) setT(0)
          setPlaying(!playing)
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      <label className="anim-speed">
        Speed {speed}x
        <input
          type="range"
          min={1}
          max={32}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </label>
      <input
        className="anim-progress"
        type="range"
        min={0}
        max={1000}
        value={Math.round(progress * 1000)}
        onChange={(e) => {
          setPlaying(false)
          setT((Number(e.target.value) / 1000) * timeline.totalTime)
        }}
      />
      <span className="anim-time">
        {t.toFixed(1)} / {timeline.totalTime.toFixed(1)} s
      </span>
    </div>
  )
}
