import type { Mesh } from "./types"

export const TRACE_CATEGORY = 3

/** Share vertices while retaining separate trace, pour-clip, and other paint indices. */
export function splitTraceMesh(mesh: Mesh): {
  paint: Mesh
  traces?: Mesh
  pourClip?: Mesh
} {
  let hasTraces = false
  let hasPours = false
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const category = mesh.vertices[mesh.indices[i] * 8 + 7]
    hasTraces ||= category === TRACE_CATEGORY
    hasPours ||= category === 1
  }
  if (!hasTraces || !hasPours) return { paint: mesh }
  const paint: number[] = [],
    traces: number[] = [],
    pourClip: number[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const category = mesh.vertices[mesh.indices[i] * 8 + 7]
    const triangle = mesh.indices.subarray(i, i + 3)
    const target = category === TRACE_CATEGORY ? traces : paint
    target.push(...triangle)
    if (category === 1) pourClip.push(...triangle)
  }
  const withIndices = (indices: number[]): Mesh => ({
    vertices: mesh.vertices,
    indices: new Uint32Array(indices),
  })
  return {
    paint: withIndices(paint),
    traces: withIndices(traces),
    pourClip: withIndices(pourClip),
  }
}
