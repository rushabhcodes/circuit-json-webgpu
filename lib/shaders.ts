export const geometryShader = /* wgsl */ `
struct Camera { rowX: vec4f, rowY: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> highlights: array<u32>;
struct Stroke { center: vec2f, halfSize: vec2f, axis: vec2f, halfWidth: f32, radius: f32 }
@group(0) @binding(2) var<storage, read> strokes: array<Stroke>;
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) @interpolate(flat) category: u32,
  @location(2) @interpolate(flat) selected: u32,
}
@vertex fn vertexMain(@location(0) p: vec2f, @location(1) color: vec4f,
  @location(2) element: f32, @location(3) category: f32) -> VertexOut {
  var world = p;
  if (category >= 2) {
    let stroke = strokes[u32(category) - 2u];
    let delta = p - stroke.center;
    let local = vec2f(dot(delta, stroke.axis), dot(delta, vec2f(-stroke.axis.y, stroke.axis.x)));
    let linear = vec4f(camera.rowX.xy, camera.rowY.xy);
    let determinant = camera.rowX.x * camera.rowY.y - camera.rowX.y * camera.rowY.x;
    // Bound the inverse camera scale, including rotation and shear, so the quad
    // includes the antialiasing fringe without recompiling when the camera moves.
    let padding = 1.5 * length(linear) / max(abs(determinant), 1e-12);
    let corner = sign(local) * (stroke.halfSize + vec2f(stroke.halfWidth + padding));
    world = stroke.center + vec2f(
      stroke.axis.x * corner.x - stroke.axis.y * corner.y,
      stroke.axis.y * corner.x + stroke.axis.x * corner.y);
  }
  let pixel = vec2f(dot(camera.rowX.xyz, vec3f(world, 1)), dot(camera.rowY.xyz, vec3f(world, 1)));
  var out: VertexOut;
  out.position = vec4f(pixel.x / camera.viewport.x * 2 - 1, 1 - pixel.y / camera.viewport.y * 2, 0, 1);
  let highlight = select(0.0, 1.0, (highlights[u32(element)] & 1u) != 0u);
  out.color = vec4f(mix(color.rgb, min(vec3f(1), color.rgb * 1.5), highlight), color.a);
  out.category = u32(category);
  out.selected = highlights[u32(element)] & 2u;
  return out;
}
// CDF of a pixel box projected onto the stroke normal. Taking the difference at
// the two stroke edges preserves coverage even when the stroke is subpixel.
fn pixelCDF(distance: f32, dx: f32, dy: f32) -> f32 {
  let major = max(max(dx, dy), 1e-6);
  let minor = min(dx, dy);
  if (minor < major * 1e-5) { return clamp(0.5 + distance / major, 0, 1); }
  let edge = (major + minor) * 0.5;
  if (distance <= -edge) { return 0; }
  if (distance >= edge) { return 1; }
  let flat = (major - minor) * 0.5;
  if (distance < -flat) { return (distance + edge) * (distance + edge) / (2 * major * minor); }
  if (distance > flat) { return 1 - (edge - distance) * (edge - distance) / (2 * major * minor); }
  return 0.5 + distance / major;
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  var coverage = 1.0;
  if (in.category >= 2u) {
    let stroke = strokes[in.category - 2u];
    let determinant = camera.rowX.x * camera.rowY.y - camera.rowX.y * camera.rowY.x;
    let screen = in.position.xy - vec2f(camera.rowX.z, camera.rowY.z);
    let worldDx = vec2f(camera.rowY.y, -camera.rowY.x) / determinant;
    let worldDy = vec2f(-camera.rowX.y, camera.rowX.x) / determinant;
    let world = screen.x * worldDx + screen.y * worldDy;
    let delta = world - stroke.center;
    let local = vec2f(dot(delta, stroke.axis), dot(delta, vec2f(-stroke.axis.y, stroke.axis.x)));
    let q = abs(local) - stroke.halfSize + vec2f(stroke.radius);
    let rounded = max(q, vec2f(0));
    let radius = length(rounded);
    let distance = radius + min(max(q.x, q.y), 0) - stroke.radius;
    var gradient = select(vec2f(0, 1), vec2f(1, 0), q.x > q.y);
    if (radius > 0) { gradient = rounded / radius; }
    gradient *= select(vec2f(-1), vec2f(1), local >= vec2f(0));
    let normal = vec2f(stroke.axis.x * gradient.x - stroke.axis.y * gradient.y,
      stroke.axis.y * gradient.x + stroke.axis.x * gradient.y);
    let dx = abs(dot(normal, worldDx));
    let dy = abs(dot(normal, worldDy));
    coverage = clamp(pixelCDF(stroke.halfWidth - distance, dx, dy)
      - pixelCDF(-stroke.halfWidth - distance, dx, dy), 0, 1);
  }
  if (in.category == 1u && camera.viewport.z == 0) { discard; }
  if (camera.viewport.w == 1) {
    if (in.selected == 0u) { discard; }
    return vec4f(in.color.rgb * coverage, coverage);
  }
  let alpha = in.color.a * coverage * select(1.0, camera.viewport.z, in.category == 1u);
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
