export const geometryShader = /* wgsl */ `
struct Camera { rowX: vec4f, rowY: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> highlights: array<u32>;
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) @interpolate(flat) category: u32,
  @location(2) @interpolate(flat) selected: u32,
  @location(3) stroke: vec3f,
}
fn projectVertex(p: vec2f, color: vec4f, element: f32, category: f32) -> VertexOut {
  let pixel = vec2f(dot(camera.rowX.xyz, vec3f(p, 1)), dot(camera.rowY.xyz, vec3f(p, 1)));
  var out: VertexOut;
  out.position = vec4f(pixel.x / camera.viewport.x * 2 - 1, 1 - pixel.y / camera.viewport.y * 2, 0, 1);
  let highlight = select(0.0, 1.0, (highlights[u32(element)] & 1u) != 0u);
  out.color = vec4f(mix(color.rgb, min(vec3f(1), color.rgb * 1.5), highlight), color.a);
  out.category = u32(category);
  out.selected = highlights[u32(element)] & 2u;
  out.stroke = vec3f(0);
  return out;
}
@vertex fn vertexMain(@location(0) p: vec2f, @location(1) color: vec4f,
  @location(2) element: f32, @location(3) category: f32) -> VertexOut {
  return projectVertex(p, color, element, category);
}
@vertex fn strokeVertexMain(@location(0) p: vec2f, @location(1) color: vec4f,
  @location(2) element: f32, @location(3) category: f32, @location(4) stroke: vec4f) -> VertexOut {
  let determinant = camera.rowX.x * camera.rowY.y - camera.rowX.y * camera.rowY.x;
  // The inverse matrix norm conservatively covers a pixel under rotation/shear.
  let fringe = length(vec4f(camera.rowX.xy, camera.rowY.xy)) / max(abs(determinant), 1e-20);
  var out = projectVertex(p + stroke.xy * stroke.w * fringe, color, element, category);
  out.stroke = vec3f(stroke.w * (stroke.z + fringe), stroke.z, abs(stroke.w));
  return out;
}
// CDF of a linear distance field over a square pixel: two uniform distributions.
fn pixelCdf(t: f32, a: f32, b: f32) -> f32 {
  let x = abs(t);
  let outer = (a + b) * 0.5;
  var positive = 1.0;
  if (x < (a - b) * 0.5) {
    positive = 0.5 + x / a;
  } else if (x < outer) {
    positive = 1.0 - (outer - x) * (outer - x) / max(2 * a * b, 1e-20);
  }
  return select(positive, 1.0 - positive, t < 0);
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let gradient = abs(vec2f(dpdx(in.stroke.x), dpdy(in.stroke.x)));
  let a = max(max(gradient.x, gradient.y), 1e-10);
  let b = min(gradient.x, gradient.y);
  let strokeCoverage = clamp(pixelCdf(in.stroke.y - in.stroke.x, a, b)
    - pixelCdf(-in.stroke.y - in.stroke.x, a, b), 0, 1);
  let coverage = select(1.0, strokeCoverage, in.stroke.z > 0.5);
  if (in.category == 1u && camera.viewport.z == 0) { discard; }
  if (camera.viewport.w == 1) {
    if (in.selected == 0u) { discard; }
    return vec4f(in.color.rgb * coverage, coverage);
  }
  let alpha = in.color.a * select(1.0, camera.viewport.z, in.category == 1u) * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`
export const compositeShader = /* wgsl */ `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> fade: vec4f;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Out {
  let points = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  var out: Out;
  out.uv = points[index];
  out.position = vec4f(out.uv.x * 2 - 1, 1 - out.uv.y * 2, 0, 1);
  return out;
}
@fragment fn fragmentMain(in: Out) -> @location(0) vec4f {
  return textureSample(image, imageSampler, in.uv) * fade.x;
}
`
