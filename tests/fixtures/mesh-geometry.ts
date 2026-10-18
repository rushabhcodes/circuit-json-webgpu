import type { Mesh, Point } from "../../lib/types"

export function area(mesh: Mesh) {
  let area = 0
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [...mesh.indices.slice(i, i + 3)].map((index) => ({
      x: mesh.vertices[index * 8],
      y: mesh.vertices[index * 8 + 1],
    }))
    area += Math.abs(cross({ a, b, c })) / 2
  }
  return area
}

export function meshBounds(mesh: Mesh) {
  const xs: number[] = [],
    ys: number[] = []
  for (let i = 0; i < mesh.vertices.length; i += 8) {
    xs.push(mesh.vertices[i])
    ys.push(mesh.vertices[i + 1])
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

export function meshCovers({ mesh, point }: { mesh: Mesh; point: Point }) {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [...mesh.indices.slice(i, i + 3)].map((index) => ({
      x: mesh.vertices[index * 8],
      y: mesh.vertices[index * 8 + 1],
    }))
    if (cross({ a, b, c }) === 0) continue
    const sides = [
      cross({ a, b, c: point }),
      cross({ a: b, b: c, c: point }),
      cross({ a: c, b: a, c: point }),
    ]
    if (sides.every((side) => side >= 0) || sides.every((side) => side <= 0))
      return true
  }
  return false
}

function cross({ a, b, c }: { a: Point; b: Point; c: Point }) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}
