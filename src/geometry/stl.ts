import type { Triangle } from './types'

/**
 * Minimal STL parser (binary and ASCII). STL coordinates are in millimetres;
 * they are converted to microns to match the rest of the pipeline.
 */

const MM_TO_UM = 1000

export function parseStl(data: ArrayBuffer): Triangle[] {
  return isBinaryStl(data) ? parseBinaryStl(data) : parseAsciiStl(new TextDecoder().decode(data))
}

function isBinaryStl(data: ArrayBuffer): boolean {
  if (data.byteLength < 84) return false
  const view = new DataView(data)
  const count = view.getUint32(80, true)
  return 84 + count * 50 === data.byteLength
}

function parseBinaryStl(data: ArrayBuffer): Triangle[] {
  const view = new DataView(data)
  const count = view.getUint32(80, true)
  const triangles: Triangle[] = []
  let offset = 84
  for (let i = 0; i < count; i++) {
    offset += 12 // skip normal
    const read = () => {
      const x = view.getFloat32(offset, true) * MM_TO_UM
      const y = view.getFloat32(offset + 4, true) * MM_TO_UM
      const z = view.getFloat32(offset + 8, true) * MM_TO_UM
      offset += 12
      return { x, y, z }
    }
    const a = read()
    const b = read()
    const c = read()
    triangles.push({ a, b, c })
    offset += 2 // attribute byte count
  }
  return triangles
}

function parseAsciiStl(text: string): Triangle[] {
  const triangles: Triangle[] = []
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
  const verts: { x: number; y: number; z: number }[] = []
  let m: RegExpExecArray | null
  while ((m = vertexRe.exec(text)) !== null) {
    verts.push({
      x: parseFloat(m[1]) * MM_TO_UM,
      y: parseFloat(m[2]) * MM_TO_UM,
      z: parseFloat(m[3]) * MM_TO_UM,
    })
    if (verts.length === 3) {
      triangles.push({ a: verts[0], b: verts[1], c: verts[2] })
      verts.length = 0
    }
  }
  return triangles
}

/**
 * Adjacency via shared edges, like CuraEngine's OptimizedModel: two triangles
 * are neighbours when they share an edge (quantized endpoints). Used by the
 * slicer to stitch line segments into polygons faster.
 */
export interface MeshAdjacency {
  /** neighbours[t] = indices of triangles sharing an edge with triangle t. */
  neighbours: number[][]
}

export function buildAdjacency(triangles: Triangle[]): MeshAdjacency {
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x / 10)},${Math.round(y / 10)},${Math.round(z / 10)}` // 0.01 mm tolerance
  const edgeOwners = new Map<string, number[]>()
  const neighbours: number[][] = triangles.map(() => [])
  triangles.forEach((tri, ti) => {
    const pts = [tri.a, tri.b, tri.c]
    for (let e = 0; e < 3; e++) {
      const p = pts[e]
      const q = pts[(e + 1) % 3]
      const k1 = key(p.x, p.y, p.z)
      const k2 = key(q.x, q.y, q.z)
      const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
      const owners = edgeOwners.get(edgeKey)
      if (owners) {
        for (const other of owners) {
          neighbours[ti].push(other)
          neighbours[other].push(ti)
        }
        owners.push(ti)
      } else {
        edgeOwners.set(edgeKey, [ti])
      }
    }
  })
  return { neighbours }
}

/** Bounding box in Z, microns. */
export function zBounds(triangles: Triangle[]): { minZ: number; maxZ: number } {
  let minZ = Infinity
  let maxZ = -Infinity
  for (const t of triangles) {
    for (const p of [t.a, t.b, t.c]) {
      if (p.z < minZ) minZ = p.z
      if (p.z > maxZ) maxZ = p.z
    }
  }
  return { minZ, maxZ }
}
