import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Triangle } from '../geometry/types'
import type { FeatureKind, Polyline, SlicedLayer } from '../algorithms/types'
import type { PipelineParams } from '../state/pipeline'
import { PipelineCache } from '../state/pipelineCache'
import { buildRibbons } from './ribbon3d'
import { featureColors, type VisState } from './vis'

/**
 * Perspective 3D view for multi-layer (STL) sources. The source mesh renders
 * translucent so toolpaths show through; toolpath layers stack at their real Z
 * heights, the current layer at full brightness and earlier layers dimmed.
 * Layers appear progressively as the PipelineCache finishes them.
 *
 * World mapping: microns with Z up (matching the slicer), inside a root group
 * scaled by 0.001 so the camera works in millimetres.
 */

const MM = 0.001
const DIM = 0.65
const TRAVEL_RGB: [number, number, number] = [0x3a / 255, 0x86 / 255, 0xff / 255]

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
]

const scaleRgb = (c: [number, number, number], f: number): [number, number, number] => [
  c[0] * f,
  c[1] * f,
  c[2] * f,
]

function featureVisible(kind: FeatureKind, vis: VisState): boolean {
  switch (kind) {
    case 'infill':
      return vis.infillLines
    case 'skin':
      return vis.skinLines
    case 'outer-wall':
    case 'inner-wall':
    case 'gap-fill':
      return vis.wallPaths
  }
}

interface SceneState {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  meshHolder: THREE.Group
  toolpaths: THREE.Group
  wallMat: THREE.MeshBasicMaterial
  travelMat: THREE.LineBasicMaterial
  meshMat: THREE.MeshLambertMaterial
  render: () => void
}

function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose()
      // Materials are shared and owned by SceneState; only geometries go.
    }
  }
}

interface View3DProps {
  triangles: Triangle[]
  layers: SlicedLayer[]
  layerIndex: number
  params: PipelineParams
  vis: VisState
  fitKey: number
}

export function View3D(props: View3DProps) {
  const { triangles, layers, layerIndex, params, vis } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneState | null>(null)
  const cacheRef = useRef<PipelineCache | null>(null)
  if (!cacheRef.current) cacheRef.current = new PipelineCache()
  const jobKey = useRef<{ layers: SlicedLayer[]; params: PipelineParams } | null>(null)
  const [tick, setTick] = useState(0)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [failed, setFailed] = useState(false)

  // Mount: renderer, scene, camera, controls, lights. Cleanup disposes all GPU
  // resources; safe under StrictMode double-mount.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setFailed(true)
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    renderer.setSize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight))
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#16181d')
    const camera = new THREE.PerspectiveCamera(
      45,
      Math.max(1, el.clientWidth) / Math.max(1, el.clientHeight),
      0.1,
      10000,
    )
    camera.up.set(0, 0, 1)
    camera.position.set(80, -80, 60)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(60, -40, 120)
    scene.add(sun)

    const grid = new THREE.GridHelper(120, 12, 0x2f3540, 0x22262e)
    grid.rotation.x = Math.PI / 2 // GridHelper is XZ; our Z is up
    scene.add(grid)

    const root = new THREE.Group()
    root.scale.setScalar(MM)
    scene.add(root)
    const meshHolder = new THREE.Group()
    const toolpaths = new THREE.Group()
    root.add(meshHolder)
    root.add(toolpaths)

    const wallMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    const travelMat = new THREE.LineBasicMaterial({ vertexColors: true })
    const meshMat = new THREE.MeshLambertMaterial({
      color: 0x9aa4b2,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    const state: SceneState = {
      renderer,
      scene,
      camera,
      controls,
      meshHolder,
      toolpaths,
      wallMat,
      travelMat,
      meshMat,
      render: () => renderer.render(scene, camera),
    }
    sceneRef.current = state

    controls.addEventListener('change', state.render)
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, el.clientWidth)
      const h = Math.max(1, el.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      state.render()
    })
    ro.observe(el)
    state.render()

    return () => {
      ro.disconnect()
      controls.dispose()
      disposeChildren(meshHolder)
      disposeChildren(toolpaths)
      wallMat.dispose()
      travelMat.dispose()
      meshMat.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // Stop background computation when the 3D view goes away.
  useEffect(() => {
    const cache = cacheRef.current!
    return () => cache.invalidate()
  }, [])

  // Schedule background toolpath computation; invalidate on params/source change.
  useEffect(() => {
    const cache = cacheRef.current!
    cache.onLayerDone = () => setTick((t) => t + 1)
    cache.onProgress = (done, total) => setProgress(done >= total ? null : { done, total })
    const key = jobKey.current
    if (!key || key.layers !== layers || key.params !== params) {
      cache.invalidate()
      jobKey.current = { layers, params }
    }
    if (layers.length > 0) cache.ensureRange(layers, 0, layerIndex, params)
    return () => {
      cache.onLayerDone = null
      cache.onProgress = null
    }
  }, [layers, params, layerIndex])

  // Rebuild the translucent source mesh.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    disposeChildren(s.meshHolder)
    if (triangles.length > 0) {
      const positions = new Float32Array(triangles.length * 9)
      triangles.forEach((t, i) => {
        positions.set([t.a.x, t.a.y, t.a.z, t.b.x, t.b.y, t.b.z, t.c.x, t.c.y, t.c.z], i * 9)
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, s.meshMat)
      mesh.renderOrder = 1 // after toolpaths
      s.meshHolder.add(mesh)
    }
    s.render()
  }, [triangles])

  // Fit the camera to the model on source change.
  useEffect(() => {
    const s = sceneRef.current
    if (!s || triangles.length === 0) return
    const box = new THREE.Box3()
    const v = new THREE.Vector3()
    for (const t of triangles) {
      for (const p of [t.a, t.b, t.c]) box.expandByPoint(v.set(p.x * MM, p.y * MM, p.z * MM))
    }
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z, 1)
    const dist = (radius / Math.tan((s.camera.fov * Math.PI) / 360)) * 1.4
    const dir = new THREE.Vector3(1, -1.2, 0.9).normalize()
    s.camera.position.copy(center).addScaledVector(dir, dist)
    s.controls.target.copy(center)
    s.controls.update()
    s.render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey, triangles])

  // Rebuild toolpath geometry from whatever the cache has so far.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const cache = cacheRef.current!
    disposeChildren(s.toolpaths)
    for (let i = 0; i <= layerIndex && i < layers.length; i++) {
      const result = cache.get(i)
      if (!result) continue
      const z = layers[i]?.z ?? i * params.layerHeight
      const bright = i === layerIndex ? 1 : DIM
      for (const feat of result.features) {
        if (feat.lines.length === 0 || !featureVisible(feat.kind, vis)) continue
        const rgb = featureColors[feat.kind]
        if (!rgb) continue
        const data = buildRibbons(feat.lines, z, scaleRgb(hexToRgb(rgb), bright))
        if (data.indices.length === 0) continue
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3))
        geo.setIndex(new THREE.BufferAttribute(data.indices, 1))
        s.toolpaths.add(new THREE.Mesh(geo, s.wallMat))
      }
      if (vis.travel) {
        const positions: number[] = []
        const colors: number[] = []
        const c = scaleRgb(TRAVEL_RGB, bright)
        for (const move of result.moves) {
          if (move.kind !== 'travel') continue
          const pts = move.line as Polyline
          for (let k = 1; k < pts.length; k++) {
            positions.push(pts[k - 1].x, pts[k - 1].y, z, pts[k].x, pts[k].y, z)
            colors.push(...c, ...c)
          }
        }
        if (positions.length > 0) {
          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
          geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
          s.toolpaths.add(new THREE.LineSegments(geo, s.travelMat))
        }
      }
    }
    s.render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, layers, layerIndex, vis, params])

  return (
    <div ref={containerRef} className="view3d">
      {failed && <div className="view3d-overlay">WebGL is not available.</div>}
      {progress && (
        <div className="view3d-overlay view3d-progress">
          computing toolpaths {progress.done} / {progress.total}
        </div>
      )}
    </div>
  )
}
