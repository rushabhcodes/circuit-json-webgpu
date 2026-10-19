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
  @location(4) @interpolate(flat) circle: vec4f,
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
  out.circle = vec4f(0);
  return out;
}
@vertex fn vertexMain(@location(0) p: vec2f, @location(1) color: vec4f,
  @location(2) element: f32, @location(3) category: f32) -> VertexOut {
  return projectVertex(p, color, element, category);
}
@vertex fn strokeVertexMain(@location(0) p: vec2f, @location(1) color: vec4f,
  @location(2) element: f32, @location(3) category: f32, @location(4) stroke: vec4f,
  @location(5) limit: vec2f) -> VertexOut {
  let determinant = camera.rowX.x * camera.rowY.y - camera.rowX.y * camera.rowY.x;
  // Sum of inverse-axis lengths covers a whole pixel under rotation/shear.
  let fringe = (length(camera.rowX.xy) + length(camera.rowY.xy)) / max(abs(determinant), 1e-20);
  let inset = max(0, limit.x - stroke.z);
  let expansion = select(fringe, min(fringe, inset), stroke.w < 0);
  var out = projectVertex(p + stroke.xy * stroke.w * expansion, color, element, category);
  out.stroke = vec3f(stroke.w * (stroke.z + expansion), stroke.z, abs(stroke.w));
  if (limit.y > 0 && fringe >= inset) {
    // Once the inner ribbon reaches the center, integrate the entire annulus
    // over each pixel instead of approximating it with a locally straight line.
    let center = p - stroke.xy * (limit.x + stroke.w * stroke.z);
    out.circle = vec4f(center, limit.y, stroke.z);
  }
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
fn cross(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }
fn angle(a: vec2f, b: vec2f) -> f32 {
  if (dot(a, a) == 0 || dot(b, b) == 0) { return 0; }
  // atan2's signed-zero behavior varies across GPU backends.
  if (cross(a, b) == 0) { return select(0.0, 3.14159265359, dot(a, b) < 0); }
  return atan2(cross(a, b), dot(a, b));
}
// Twice the signed disk/triangle intersection area for the triangle (0, a, b).
// Split the edge at its circle intersections: the inside contributes a triangle,
// while each outside part contributes a circular sector.
fn diskEdge(a: vec2f, b: vec2f, radius: f32) -> f32 {
  let edge = b - a;
  let lengthSquared = dot(edge, edge);
  let discriminant = radius * radius * lengthSquared - cross(a, b) * cross(a, b);
  if (discriminant <= 0) { return radius * radius * angle(a, b); }
  let midpoint = -dot(a, edge) / lengthSquared;
  let halfSpan = sqrt(discriminant) / lengthSquared;
  let u = a + edge * clamp(midpoint - halfSpan, 0, 1);
  let v = a + edge * clamp(midpoint + halfSpan, 0, 1);
  return cross(u, v) + radius * radius * (angle(a, u) + angle(v, b));
}
fn diskPixel(p: vec2f, dx: vec2f, dy: vec2f, radius: f32) -> f32 {
  if (radius <= 0) { return 0; }
  return abs(diskEdge(p, p + dx, radius) + diskEdge(p + dx, p + dx + dy, radius)
    + diskEdge(p + dx + dy, p + dy, radius) + diskEdge(p + dy, p, radius)) * 0.5;
}
fn circleCoverage(pixel: vec2f, circle: vec4f) -> f32 {
  let determinant = camera.rowX.x * camera.rowY.y - camera.rowX.y * camera.rowY.x;
  let center = vec2f(dot(camera.rowX.xyz, vec3f(circle.xy, 1)), dot(camera.rowY.xyz, vec3f(circle.xy, 1)));
  // Normalize by radius before integrating, avoiding cancellation at world scale.
  let dx = vec2f(camera.rowY.y, -camera.rowY.x) / (determinant * circle.z);
  let dy = vec2f(-camera.rowX.y, camera.rowX.x) / (determinant * circle.z);
  let offset = floor(pixel) - center;
  let p = dx * offset.x + dy * offset.y;
  let halfWidth = circle.w / circle.z;
  let area = diskPixel(p, dx, dy, 1 + halfWidth) - diskPixel(p, dx, dy, max(0, 1 - halfWidth));
  return clamp(area * circle.z * circle.z * abs(determinant), 0, 1);
}
@fragment fn strokeFragmentMain(in: VertexOut) -> @location(0) vec4f {
  let gradient = abs(vec2f(dpdx(in.stroke.x), dpdy(in.stroke.x)));
  let a = max(max(gradient.x, gradient.y), 1e-10);
  let b = min(gradient.x, gradient.y);
  let strokeCoverage = clamp(pixelCdf(in.stroke.y - in.stroke.x, a, b)
    - pixelCdf(-in.stroke.y - in.stroke.x, a, b), 0, 1);
  var coverage = select(1.0, strokeCoverage, in.stroke.z > 0.5);
  if (in.circle.z > 0) { coverage = circleCoverage(in.position.xy, in.circle); }
  return shade(in, coverage);
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  return shade(in, 1.0);
}
fn shade(in: VertexOut, coverage: f32) -> vec4f {
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
