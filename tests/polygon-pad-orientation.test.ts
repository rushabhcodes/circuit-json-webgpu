import { expect, test } from "bun:test"
import { createCanvas } from "@napi-rs/canvas"
import { pcb_plated_hole } from "circuit-json"
import { drawPcbPlatedHole } from "circuit-to-canvas/lib/drawer/elements/pcb-plated-hole"
import { DEFAULT_PCB_COLOR_MAP } from "circuit-to-canvas/lib/drawer/types"
import { compileCircuitJson } from "../lib"
import { meshBounds, meshCovers } from "./fixtures/mesh-geometry"

test("polygon pad orientation matches the reference without applying ccw_rotation twice", () => {
  for (const ccw_rotation of [0, 90, 180, 270]) {
    const hole = pcb_plated_hole.parse({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "oriented-polygon",
      shape: "hole_with_polygon_pad",
      x: 5,
      y: 5,
      // Already oriented vertically in pad-relative board axes.
      pad_outline: [
        { x: -1, y: -3 },
        { x: 1, y: -3 },
        { x: 1, y: 3 },
        { x: -1, y: 3 },
      ],
      ccw_rotation,
      hole_shape: "circle",
      hole_diameter: 0.5,
      layers: ["top", "bottom"],
    })
    const scene = compileCircuitJson([hole])
    expect(scene.diagnostics).toEqual([])
    const mesh = scene.layers.find((layer) => layer.name === "top")!.paint
    expect(meshBounds(mesh)).toEqual([4, 6, 2, 8])

    const canvas = createCanvas(100, 100)
    const ctx = canvas.getContext("2d")
    drawPcbPlatedHole({
      ctx,
      hole,
      realToCanvasMat: { a: 10, b: 0, c: 0, d: -10, e: 0, f: 100 },
      colorMap: DEFAULT_PCB_COLOR_MAP,
      layer: "top",
    })
    for (const { point, copper } of [
      { point: { x: 5.5, y: 7 }, copper: true },
      { point: { x: 4.5, y: 3 }, copper: true },
      { point: { x: 7, y: 5 }, copper: false },
      { point: { x: 3, y: 5 }, copper: false },
    ]) {
      const alpha = ctx.getImageData(point.x * 10, 100 - point.y * 10, 1, 1)
        .data[3]
      expect(alpha).toBe(copper ? 255 : 0)
      expect(meshCovers({ mesh, point })).toBe(copper)
    }
  }
})
