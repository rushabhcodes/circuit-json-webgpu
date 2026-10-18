import type { Point } from "./types"

/** A convex, gently turning closed path can use a continuous stroke ribbon. */
export function getSmoothStroke(points: Point[], width: number) {
  if (!(width > 0) || !Number.isFinite(width)) return
  const samePoint = (a: Point, b: Point) =>
    Math.hypot(a.x - b.x, a.y - b.y) <=
    Number.EPSILON *
      8 *
      Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y))
  const ring: Point[] = []
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    if (!ring.length || !samePoint(ring.at(-1)!, point)) ring.push(point)
  }
  if (ring.length > 1 && samePoint(ring[0], ring.at(-1)!)) ring.pop()
  if (ring.length < 8) return
  const origin = ring[0]
  let area = 0
  const directions = ring.map((point, i) => {
    const next = ring[(i + 1) % ring.length]
    area +=
      (point.x - origin.x) * (next.y - origin.y) -
      (next.x - origin.x) * (point.y - origin.y)
    const dx = next.x - point.x,
      dy = next.y - point.y
    const length = Math.hypot(dx, dy)
    return { x: dx / length, y: dy / length }
  })
  const winding = Math.sign(area)
  if (!winding) return
  const normals: Point[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = directions[(i + ring.length - 1) % ring.length],
      b = directions[i]
    const dot = a.x * b.x + a.y * b.y
    const turn = (a.x * b.y - a.y * b.x) * winding
    // Sharp corners, concavity, and collapsed insets retain the general stroker.
    if (dot < Math.cos(Math.PI / 8) || turn < -Number.EPSILON * 32) return
    normals.push({
      x: (winding * (a.y + b.y)) / (1 + dot),
      y: (-winding * (a.x + b.x)) / (1 + dot),
    })
  }
  for (let i = 0; i < ring.length; i++) {
    const next = (i + 1) % ring.length
    const dx =
      ring[next].x - ring[i].x - (width / 2) * (normals[next].x - normals[i].x)
    const dy =
      ring[next].y - ring[i].y - (width / 2) * (normals[next].y - normals[i].y)
    if (dx * directions[i].x + dy * directions[i].y <= 0) return
  }
  return { points: ring, normals }
}
