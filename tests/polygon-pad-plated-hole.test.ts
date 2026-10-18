import { expect, test } from "bun:test"
import { pcb_plated_hole } from "circuit-json"
import { compileCircuitJson } from "../lib"
import { area, meshBounds } from "./fixtures/mesh-geometry"

test("polygon-pad plated holes retain translated copper and offset drills on each layer", () => {
  for (const hole_shape of [
    "circle",
    "oval",
    "pill",
    "rotated_pill",
  ] as const) {
    const input = pcb_plated_hole.parse({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "polygon-hole",
      shape: "hole_with_polygon_pad",
      x: 10,
      y: -7,
      pad_outline: [
        { x: -4, y: -3 },
        { x: 4, y: -3 },
        { x: 4, y: 3 },
        { x: -4, y: 3 },
      ],
      layers: ["top", "inner1", "bottom"],
      hole_shape,
      hole_diameter: 2,
      hole_width: 4,
      hole_height: 2,
      hole_offset_x: 1,
      hole_offset_y: -1,
      ccw_rotation: hole_shape === "rotated_pill" ? 90 : 0,
    })
    const original = structuredClone(input)
    const scene = compileCircuitJson([input])
    expect(scene.diagnostics).toEqual([])
    expect(scene.elementIds).toEqual(["polygon-hole"])
    const drill = scene.layers.find((layer) => layer.name === "drill")!.paint
    const [minX, maxX, minY, maxY] = meshBounds(drill)
    expect((minX + maxX) / 2).toBeCloseTo(11)
    expect((minY + maxY) / 2).toBeCloseTo(-8)
    expect(maxX - minX).toBeCloseTo(
      hole_shape === "circle" || hole_shape === "rotated_pill" ? 2 : 4,
    )
    expect(maxY - minY).toBeCloseTo(hole_shape === "rotated_pill" ? 4 : 2)
    expect(area(drill)).toBeCloseTo(
      hole_shape === "circle"
        ? Math.PI
        : hole_shape === "oval"
          ? 2 * Math.PI
          : 4 + Math.PI,
      1,
    )
    for (const name of ["top", "inner1", "bottom"]) {
      const layer = scene.layers.find((layer) => layer.name === name)!
      expect(area(layer.paint)).toBeCloseTo(48)
      expect(meshBounds(layer.paint)).toEqual([6, 14, -10, -4])
      expect(layer.erase.indices).toEqual(drill.indices)
      expect(layer.erase.vertices.filter((_, i) => i % 8 < 2)).toEqual(
        drill.vertices.filter((_, i) => i % 8 < 2),
      )
    }
    expect(
      meshBounds(scene.layers.find((layer) => layer.name === "board")!.erase),
    ).toEqual(meshBounds(drill))
    for (const side of ["top", "bottom"])
      expect(
        area(
          scene.layers.find((layer) => layer.name === `soldermask_${side}`)!
            .erase,
        ),
      ).toBeCloseTo(48 + area(drill))
    for (const layer of scene.layers)
      for (const mesh of [layer.paint, layer.erase])
        expect(
          [...mesh.vertices]
            .filter((_, i) => i % 8 === 6)
            .every((index) => index === 0),
        ).toBe(true)
    expect(input).toEqual(original)
  }
})
