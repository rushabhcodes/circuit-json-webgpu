import { expect, test } from "bun:test"
import { compileCircuitJson, type CircuitJson } from "../lib"
import { splitTraceMesh, TRACE_CATEGORY } from "../lib/split-trace-mesh"
import { meshCovers } from "./fixtures/mesh-geometry"

const pour = {
  type: "pcb_copper_pour" as const,
  pcb_copper_pour_id: "pour",
  shape: "brep" as const,
  layer: "top" as const,
  covered_with_solder_mask: false,
  brep_shape: {
    outer_ring: {
      vertices: [
        { x: -5, y: -3 },
        { x: 5, y: -3 },
        { x: 5, y: 3 },
        { x: -5, y: 3 },
      ],
    },
    inner_rings: [
      {
        vertices: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      },
    ],
  },
}
const trace = {
  type: "pcb_trace" as const,
  pcb_trace_id: "trace",
  route: [
    {
      route_type: "wire" as const,
      x: -8,
      y: 0,
      width: 0.5,
      layer: "top" as const,
    },
    {
      route_type: "wire" as const,
      x: 8,
      y: 0,
      width: 0.5,
      layer: "top" as const,
    },
  ],
}

test("retained clipping shares vertices, preserves clearance holes, and keeps pads out of the trace pass", () => {
  const scene = compileCircuitJson([
    trace,
    pour,
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad",
      shape: "rect",
      x: 3,
      y: 0,
      width: 1,
      height: 1,
      layer: "top",
    },
    {
      type: "pcb_via",
      pcb_via_id: "via",
      x: -3,
      y: 0,
      outer_diameter: 2,
      hole_diameter: 1,
      layers: ["top", "bottom"],
    },
  ])
  expect(scene.diagnostics).toEqual([])
  const layer = scene.layers.find((layer) => layer.name === "top")!
  const original = structuredClone(layer.paint)
  const meshes = splitTraceMesh(layer.paint)
  expect(meshes.traces!.vertices).toBe(layer.paint.vertices)
  expect(meshes.pourClip!.vertices).toBe(layer.paint.vertices)
  expect(layer.paint).toEqual(original)
  expect(meshes.paint.indices.length + meshes.traces!.indices.length).toBe(
    layer.paint.indices.length,
  )
  const point = (x: number) => ({ x, y: 0 })
  expect(meshCovers({ mesh: meshes.pourClip!, point: point(3) })).toBe(true)
  expect(meshCovers({ mesh: meshes.pourClip!, point: point(0) })).toBe(false)
  expect(meshCovers({ mesh: meshes.traces!, point: point(0) })).toBe(true)
  expect(meshCovers({ mesh: meshes.traces!, point: point(6) })).toBe(true)
  expect(meshCovers({ mesh: layer.erase, point: point(-3) })).toBe(true)
  for (const index of meshes.traces!.indices) {
    expect(meshes.traces!.vertices[index * 8 + 6]).toBe(0)
    expect(meshes.traces!.vertices[index * 8 + 7]).toBe(TRACE_CATEGORY)
  }
  for (const index of meshes.paint.indices)
    expect(meshes.paint.vertices[index * 8 + 7]).not.toBe(TRACE_CATEGORY)
  for (const index of meshes.pourClip!.indices)
    expect(meshes.pourClip!.vertices[index * 8 + 6]).toBe(1)
})

test("tapered wires, via connectors, and through-pad spans retain their owning trace identity", () => {
  const variants: CircuitJson[] = [
    [
      {
        ...trace,
        route: [
          {
            ...trace.route[0],
            width: 2,
            ...{
              start_width: 2,
              end_width: 0.5,
              width_interpolation_mode: "linear",
            },
          },
          trace.route[1],
        ],
      },
    ],
    [
      {
        ...trace,
        route: [
          trace.route[0],
          {
            route_type: "via",
            x: 8,
            y: 0,
            from_layer: "top",
            to_layer: "bottom",
          },
        ],
      },
    ],
    [
      {
        ...trace,
        route: [
          {
            route_type: "via",
            x: -8,
            y: 0,
            from_layer: "bottom",
            to_layer: "top",
          },
          trace.route[1],
        ],
      },
    ],
    [
      {
        ...trace,
        route: [
          {
            route_type: "through_pad",
            start: { x: -8, y: 0 },
            end: { x: 8, y: 0 },
            start_layer: "top",
            end_layer: "bottom",
            width: 0.5,
          },
        ],
      },
    ],
  ]
  for (const elements of variants) {
    const scene = compileCircuitJson([pour, ...elements])
    expect(scene.diagnostics).toEqual([])
    const mesh = splitTraceMesh(
      scene.layers.find((layer) => layer.name === "top")!.paint,
    ).traces!
    expect(meshCovers({ mesh, point: { x: 0, y: 0 } })).toBe(true)
    for (const index of mesh.indices) {
      expect(mesh.vertices[index * 8 + 6]).toBe(1)
      expect(mesh.vertices[index * 8 + 7]).toBe(TRACE_CATEGORY)
    }
  }
})

test("layers without both traces and pours retain the original mesh and avoid extra passes", () => {
  for (const elements of [[trace], [pour], []] as CircuitJson[]) {
    const scene = compileCircuitJson(elements)
    for (const layer of scene.layers) {
      const meshes = splitTraceMesh(layer.paint)
      expect(meshes.paint).toBe(layer.paint)
      expect(meshes.traces).toBeUndefined()
      expect(meshes.pourClip).toBeUndefined()
    }
  }
})
