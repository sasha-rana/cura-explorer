/**
 * Core geometry types.
 *
 * Like CuraEngine, all coordinates are integer microns (1000 = 1 mm) so they can
 * be fed straight into Clipper, which works on 64-bit integers.
 */

export interface Point {
  x: number
  y: number
}

/** Closed ring of points. The first point is NOT repeated at the end. */
export type Ring = Point[]

/** A polygon with one outer ring and zero or more hole rings. */
export interface Polygon {
  outer: Ring
  holes: Ring[]
}

/** Open path. */
export type Polyline = Point[]

export interface AABB {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * A single extrusion move with a (possibly variable) line width, in microns.
 * This mirrors CuraEngine's ExtrusionLine: a polyline carrying per-segment width.
 */
export interface ExtrusionJunction {
  p: Point
  /** Extrusion width at this junction, in microns. */
  w: number
}

export type ExtrusionLine = ExtrusionJunction[]

/** A 3D point, microns. */
export interface Point3 {
  x: number
  y: number
  z: number
}

export interface Triangle {
  a: Point3
  b: Point3
  c: Point3
}
