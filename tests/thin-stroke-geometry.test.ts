import { expect, test } from "bun:test"
import { compileCircuitJson } from "../lib"
import { ellipse, MeshBuilder, rectangle } from "../lib/geometry"
import { area, meshBounds, meshCovers } from "./fixtures/mesh-geometry"

test("smooth closed strokes retain physical width, hollow centers, area, and identity in either winding", () => {
  for (const points of [
    ellipse({ x: 0, y: 0 }, 20),
    rectangle({ x: 0, y: 0 }, 20, 12, 3, 27),
  ]) {
    const original = structuredClone(points)
    const perimeter = points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length]
      return sum + Math.hypot(next.x - p.x, next.y - p.y)
    }, 0)
    for (const ring of [
      points,
      [...points].reverse(),
      [...points, points[0]],
    ]) {
      const builder = new MeshBuilder([1, 0, 0, 0.5], 7)
      builder.path(ring, 0.1, true)
      const mesh = builder.build()
      expect(mesh.strokeAttributes).toBeDefined()
      expect(mesh.strokeAttributes!.length).toBe(mesh.vertices.length / 2)
      expect([...mesh.strokeAttributes!].every(Number.isFinite)).toBe(true)
      expect(area(mesh)).toBeCloseTo(perimeter * 0.1, 4)
      expect(meshCovers({ mesh, point: { x: 0, y: 0 } })).toBe(false)
      expect(meshCovers({ mesh, point: points[0] })).toBe(true)
      for (let i = 0; i < mesh.vertices.length / 8; i++) {
        expect(mesh.vertices[i * 8 + 6]).toBe(7)
        expect(mesh.strokeAttributes![i * 4 + 2]).toBeCloseTo(0.05)
      }
    }
    expect(points).toEqual(original)
  }
  const circle = new MeshBuilder()
  circle.path(ellipse({ x: 0, y: 0 }, 20), 0.1, true)
  for (const [i, expected] of [-10.05, 10.05, -10.05, 10.05].entries())
    expect(meshBounds(circle.build())[i]).toBeCloseTo(expected, 3)
})

test("ordinary polygons before and after a smooth stroke keep their geometry and aligned attributes", () => {
  const builder = new MeshBuilder()
  const triangle = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 0, y: 1 },
  ]
  builder.polygon([triangle])
  builder.path(ellipse({ x: 0, y: 0 }, 20), 0.1, true)
  builder.element = 9
  builder.polygon([triangle])
  const mesh = builder.build()
  expect(mesh.strokeAttributes!.slice(0, 12)).toEqual(new Float32Array(12))
  expect(mesh.strokeAttributes!.slice(-12)).toEqual(new Float32Array(12))
  expect(mesh.strokeAttributes!.length).toBe(mesh.vertices.length / 2)
  expect(meshCovers({ mesh, point: { x: 0, y: 0 } })).toBe(true)
  expect([...mesh.vertices.slice(-24)].filter((_, i) => i % 8 === 6)).toEqual([
    9, 9, 9,
  ])
})

test("open, sharp, concave, and collapsed strokes retain the general geometry path", () => {
  const concave = ellipse({ x: 0, y: 0 }, 20).map((p, i) => ({
    x: p.x * (1 + 0.3 * Math.cos((i * Math.PI) / 12)),
    y: p.y * (1 + 0.3 * Math.cos((i * Math.PI) / 12)),
  }))
  for (const { points, width, closed } of [
    { points: ellipse({ x: 0, y: 0 }, 20), width: 0.1, closed: false },
    { points: rectangle({ x: 0, y: 0 }, 20, 10), width: 0.1, closed: true },
    { points: concave, width: 0.1, closed: true },
    { points: ellipse({ x: 0, y: 0 }, 20), width: 30, closed: true },
  ]) {
    const builder = new MeshBuilder()
    builder.path(points, width, closed)
    expect(builder.build().strokeAttributes).toBeUndefined()
    expect(builder.build().indices.length).toBeGreaterThan(0)
  }
})

test("analytic attributes stay on curved outline layers while copper retains its original geometry", () => {
  const scene = compileCircuitJson([
    {
      type: "pcb_silkscreen_circle",
      pcb_silkscreen_circle_id: "circle",
      pcb_component_id: "component",
      layer: "top",
      center: { x: 0, y: 0 },
      radius: 10,
      stroke_width: 0.1,
    },
    {
      type: "pcb_fabrication_note_rect",
      pcb_fabrication_note_rect_id: "rounded",
      pcb_component_id: "component",
      layer: "bottom",
      center: { x: 0, y: 0 },
      width: 20,
      height: 12,
      corner_radius: 3,
      stroke_width: 0.1,
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "wire",
      route: [
        { route_type: "wire", x: -5, y: 0, width: 0.1, layer: "top" },
        { route_type: "wire", x: 5, y: 0, width: 0.1, layer: "top" },
      ],
    },
  ])
  expect(scene.diagnostics).toEqual([])
  expect(
    scene.layers.find((l) => l.name === "top_silkscreen")!.paint
      .strokeAttributes,
  ).toBeDefined()
  expect(
    scene.layers.find((l) => l.name === "bottom_fabrication")!.paint
      .strokeAttributes,
  ).toBeDefined()
  expect(
    scene.layers.find((l) => l.name === "top")!.paint.strokeAttributes,
  ).toBeUndefined()
})
