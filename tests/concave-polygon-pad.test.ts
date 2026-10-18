import { expect, test } from "bun:test"
import { pcb_plated_hole } from "circuit-json"
import { compileCircuitJson } from "../lib"
import { area, meshBounds, meshCovers } from "./fixtures/mesh-geometry"

test("concave polygon pads preserve their boundary and omitted drill offsets", () => {
  const scene = compileCircuitJson([
    pcb_plated_hole.parse({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "concave",
      shape: "hole_with_polygon_pad",
      x: -3,
      y: 7,
      pad_outline: [
        { x: -2, y: -2 },
        { x: 2, y: -2 },
        { x: 2, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 2 },
        { x: -2, y: 2 },
      ],
      layers: ["top", "bottom"],
      hole_shape: "circle",
      hole_diameter: 1,
    }),
  ])
  expect(scene.diagnostics).toEqual([])
  expect(
    area(scene.layers.find((layer) => layer.name === "top")!.paint),
  ).toBeCloseTo(12)
  for (const name of ["top", "bottom"]) {
    const mesh = scene.layers.find((layer) => layer.name === name)!.paint
    expect([...mesh.vertices].filter((_, i) => i % 8 < 2)).toEqual([
      -5, 5, -1, 5, -1, 7, -3, 7, -3, 9, -5, 9,
    ])
    expect(meshBounds(mesh)).toEqual([-5, -1, 5, 9])
    expect(meshCovers({ mesh, point: { x: -4, y: 8 } })).toBe(true)
    expect(meshCovers({ mesh, point: { x: -2, y: 6 } })).toBe(true)
    expect(meshCovers({ mesh, point: { x: -2, y: 8 } })).toBe(false)
    expect(meshCovers({ mesh, point: { x: -6, y: 6 } })).toBe(false)
  }
  expect(
    meshBounds(scene.layers.find((layer) => layer.name === "drill")!.paint),
  ).toEqual([-3.5, -2.5, 6.5, 7.5])
})
