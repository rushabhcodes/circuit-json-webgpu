import earcut from "earcut"
import polygonClipping, { type Polygon } from "polygon-clipping"
import type { Color, Mesh, Point } from "./types"
import { getSmoothStroke } from "./get-smooth-stroke"

/** Tessellation is camera-independent and runs only when circuit data changes. */
export class MeshBuilder {
  vertices: number[] = []
  indices: number[] = []
  private strokeAttributes?: number[]
  constructor(
    public color: Color = [1, 1, 1, 1],
    public element = 0,
    public category = 0,
  ) {}
  polygon(rings: Point[][]) {
    if (!rings[0] || rings[0].length < 3) return
    const points: number[] = [],
      holes: number[] = []
    for (const [i, ring] of rings.entries()) {
      if (i) holes.push(points.length / 2)
      for (const p of ring) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
          throw new Error("Non-finite polygon vertex")
        points.push(p.x, p.y)
      }
    }
    const triangles = earcut(points, holes, 2),
      base = this.vertices.length / 8
    for (let i = 0; i < points.length; i += 2)
      this.vertices.push(
        points[i],
        points[i + 1],
        ...this.color,
        this.element,
        this.category,
      )
    for (const index of triangles) this.indices.push(base + index)
    if (this.strokeAttributes)
      for (let i = 0; i < points.length / 2; i++)
        this.strokeAttributes.push(0, 0, 0, 0)
  }
  line(a: Point, b: Point, width: number) {
    if (!(width > 0)) return
    const points = capsule(a, b, width)
    this.polygon([points])
  }
  path(points: Point[], width: number, closed = false) {
    const stroke = closed ? getSmoothStroke(points, width) : undefined
    if (stroke) {
      this.strokeAttributes ??= new Array(this.vertices.length / 2).fill(0)
      const base = this.vertices.length / 8
      for (const [i, point] of stroke.points.entries()) {
        const normal = stroke.normals[i]
        for (const side of [1, -1]) {
          this.vertices.push(
            point.x + ((normal.x * width) / 2) * side,
            point.y + ((normal.y * width) / 2) * side,
            ...this.color,
            this.element,
            this.category,
          )
          this.strokeAttributes.push(normal.x, normal.y, width / 2, side)
        }
        const a = base + i * 2,
          b = base + ((i + 1) % stroke.points.length) * 2
        this.indices.push(a, b, b + 1, a, b + 1, a + 1)
      }
      return
    }
    for (let i = 1; i < points.length; i++)
      this.line(points[i - 1], points[i], width)
    if (closed && points.length > 2) this.line(points.at(-1)!, points[0], width)
  }
  fabricationPath(points: Point[], width: number, filled: boolean) {
    if (points.length < 2) return
    const polygons: Polygon[] = []
    if (filled && points.length >= 3)
      polygons.push([points.map((p) => [p.x, p.y])])
    if (width > 0) {
      const route = filled ? [...points, points[0]] : points
      for (let i = 1; i < route.length; i++)
        polygons.push([
          capsule(route[i - 1], route[i], width).map((p) => [p.x, p.y]),
        ])
    }
    if (!polygons.length) return
    // Round-cap trigonometry can place shared vertices a few ULPs apart. Snap
    // before clipping so coincident edges agree; 1e-9 mm is far below the
    // precision of the Float32 mesh uploaded to the GPU.
    const snapped = polygons.map((polygon) =>
      polygon.map((ring) =>
        ring.map<[number, number]>(([x, y]) => [
          Math.round(x * 1e9) / 1e9,
          Math.round(y * 1e9) / 1e9,
        ]),
      ),
    )
    // Tessellate the union, not overlapping triangles: source-over blending
    // must apply the note's alpha only once even at crossings and filled edges.
    for (const polygon of polygonClipping.union(
      snapped[0],
      ...snapped.slice(1),
    ))
      this.polygon(polygon.map((ring) => ring.map(([x, y]) => ({ x, y }))))
  }
  build(): Mesh {
    return {
      vertices: new Float32Array(this.vertices),
      indices: new Uint32Array(this.indices),
      ...(this.strokeAttributes
        ? { strokeAttributes: new Float32Array(this.strokeAttributes) }
        : {}),
    }
  }
}
function capsule(a: Point, b: Point, width: number): Point[] {
  const angle = Math.atan2(b.y - a.y, b.x - a.x),
    r = width / 2
  const points: Point[] = []
  for (let i = 0; i <= 12; i++) {
    const t = angle + Math.PI / 2 + (i * Math.PI) / 12
    points.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) })
  }
  for (let i = 0; i <= 12; i++) {
    const t = angle - Math.PI / 2 + (i * Math.PI) / 12
    points.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) })
  }
  return points
}
export function rotate(p: Point, center: Point, degrees = 0): Point {
  const t = (degrees * Math.PI) / 180,
    x = p.x - center.x,
    y = p.y - center.y
  return {
    x: center.x + x * Math.cos(t) - y * Math.sin(t),
    y: center.y + x * Math.sin(t) + y * Math.cos(t),
  }
}
export function ellipse(
  center: Point,
  width: number,
  height = width,
  rotation = 0,
): Point[] {
  if (!(width > 0 && height > 0)) return []
  return Array.from({ length: 96 }, (_, i) => {
    const t = (i * 2 * Math.PI) / 96
    return rotate(
      {
        x: center.x + (Math.cos(t) * width) / 2,
        y: center.y + (Math.sin(t) * height) / 2,
      },
      center,
      rotation,
    )
  })
}
export function rectangle(
  center: Point,
  width: number,
  height: number,
  radius = 0,
  rotation = 0,
): Point[] {
  if (!(width > 0 && height > 0)) return []
  radius = Math.max(0, Math.min(radius, width / 2, height / 2))
  const points: Point[] = []
  for (let corner = 0; corner < 4; corner++) {
    const sx = corner === 0 || corner === 3 ? 1 : -1
    const sy = corner < 2 ? 1 : -1
    const steps = radius ? 24 : 1
    for (let i = 0; i < steps; i++) {
      const t = ((corner + i / (steps - 1 || 1)) * Math.PI) / 2
      points.push(
        rotate(
          {
            x: center.x + sx * (width / 2 - radius) + radius * Math.cos(t),
            y: center.y + sy * (height / 2 - radius) + radius * Math.sin(t),
          },
          center,
          rotation,
        ),
      )
    }
  }
  return points
}
/** DXF-style bulges used by Circuit JSON BRep rings, including major arcs. */
export function expandBrepRing(
  vertices: (Point & { bulge?: number })[],
): Point[] {
  const points: Point[] = []
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length]
    points.push({ x: a.x, y: a.y })
    const bulge = a.bulge ?? 0,
      dx = b.x - a.x,
      dy = b.y - a.y
    if (!bulge || (!dx && !dy)) continue
    const sweep = 4 * Math.atan(bulge)
    const center = {
      x: (a.x + b.x) / 2 - (dy * (1 - bulge * bulge)) / (4 * bulge),
      y: (a.y + b.y) / 2 + (dx * (1 - bulge * bulge)) / (4 * bulge),
    }
    const angle = Math.atan2(a.y - center.y, a.x - center.x),
      r = Math.hypot(a.x - center.x, a.y - center.y)
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 48)))
    for (let j = 1; j < steps; j++)
      points.push({
        x: center.x + r * Math.cos(angle + (sweep * j) / steps),
        y: center.y + r * Math.sin(angle + (sweep * j) / steps),
      })
  }
  return points
}
