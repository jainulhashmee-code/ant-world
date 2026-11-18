/**
 * Shader sources for both backends.
 *
 * The ant is drawn procedurally — three ellipses in the fragment shader, no
 * sprite atlas, no texture fetch. That keeps it crisp at any zoom and costs
 * nothing in memory, which matters when the alternative is a second texture
 * binding per instance.
 */

// ---------------------------------------------------------------------------
// WebGPU — instanced agents and markers
// ---------------------------------------------------------------------------

export const WGSL_AGENTS = /* wgsl */ `
struct Camera {
  center: vec2f,
  resolution: vec2f,
  zoom: f32,
  antSize: f32,
  opacity: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> cam: Camera;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @location(0) iPos: vec2f,
  @location(1) iDir: vec2f,
  @location(2) iColor: vec4f,
  @location(3) iSize: f32,
) -> VSOut {
  // Single unit quad, expanded from the vertex index — no vertex buffer.
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32((vi >> 1u) & 1u) * 2.0 - 1.0);

  // Rotation straight from the unit heading: no atan2 anywhere in the pipeline.
  let rot = mat2x2f(iDir.x, iDir.y, -iDir.y, iDir.x);
  let world = iPos + rot * (corner * iSize * cam.antSize);

  let px = (world - cam.center) * cam.zoom;
  var out: VSOut;
  out.pos = vec4f(px.x / cam.resolution.x * 2.0, -px.y / cam.resolution.y * 2.0, 0.0, 1.0);
  out.local = corner;
  out.color = iColor;
  return out;
}

fn ellipseDist(p: vec2f, c: vec2f, r: vec2f) -> f32 {
  return length((p - c) / r);
}

@fragment
fn fs_ant(in: VSOut) -> @location(0) vec4f {
  // Local space is [-1, 1]², ant axis along +x: head, thorax, gaster.
  let head = ellipseDist(in.local, vec2f(0.60, 0.0), vec2f(0.26, 0.22));
  let thorax = ellipseDist(in.local, vec2f(0.14, 0.0), vec2f(0.22, 0.16));
  let gaster = ellipseDist(in.local, vec2f(-0.42, 0.0), vec2f(0.38, 0.26));
  let d = min(min(head, thorax), gaster);

  let a = 1.0 - smoothstep(0.82, 1.0, d);
  if (a < 0.02) {
    discard;
  }
  // Cheap directional shading so the body reads as a body, not a blob.
  let shade = 0.72 + 0.28 * (1.0 - in.local.y * 0.5);
  return vec4f(in.color.rgb * shade, a * in.color.a * cam.opacity);
}

@fragment
fn fs_marker(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) {
    discard;
  }
  let rim = smoothstep(1.0, 0.88, d);
  let core = 0.32 * smoothstep(1.0, 0.45, d);
  let a = max(rim, core) * in.color.a * cam.opacity;
  return vec4f(in.color.rgb, a);
}
`;

// ---------------------------------------------------------------------------
// WebGPU — pheromone background
// ---------------------------------------------------------------------------

export const WGSL_PHERO = /* wgsl */ `
struct Frame {
  center: vec2f,
  resolution: vec2f,
  zoom: f32,
  intensity: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var homeTex: texture_2d<f32>;
@group(0) @binding(2) var foodTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

const WORLD_SIZE: f32 = 4096.0;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let x = f32(vi & 1u) * 2.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Screen pixel offset from centre, then back into world space.
  let sx = (in.uv.x * 2.0 - 1.0) * frame.resolution.x * 0.5;
  let sy = -(in.uv.y * 2.0 - 1.0) * frame.resolution.y * 0.5;
  let world = frame.center + vec2f(sx, sy) / frame.zoom;
  let tuv = world / WORLD_SIZE;

  let home = textureSample(homeTex, samp, tuv).r;
  let food = textureSample(foodTex, samp, tuv).r;

  // The floor is above the decay noise and the ceiling is well under 1 so a
  // saturated trail still shows its structure instead of clipping to white.
  let h = smoothstep(0.03, 0.42, home) * frame.intensity;
  let f = smoothstep(0.03, 0.42, food) * frame.intensity;

  // Cool blue for the home corridor, warm amber for the food trail.
  var col = vec3f(0.035, 0.040, 0.055);
  col += vec3f(0.16, 0.38, 0.95) * h * 0.32;
  col += vec3f(1.00, 0.48, 0.12) * f * 0.50;

  return vec4f(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// WebGL2 — GLSL ES 3.00 mirrors of the above
// ---------------------------------------------------------------------------

const GLSL_HEADER = `#version 300 es
precision highp float;
`;

export const GLSL_ANT_HEADER = `${GLSL_HEADER}
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aDir;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aSize;

uniform vec2 uCenter;
uniform vec2 uResolution;
uniform float uZoom;
uniform float uAntSize;
uniform float uOpacity;

out vec2 vLocal;
out vec4 vColor;

void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  mat2 rot = mat2(aDir.x, aDir.y, -aDir.y, aDir.x);
  vec2 world = aPos + rot * (corner * aSize * uAntSize);
  vec2 px = (world - uCenter) * uZoom;
  gl_Position = vec4(px.x / uResolution.x * 2.0, -px.y / uResolution.y * 2.0, 0.0, 1.0);
  vLocal = corner;
  vColor = aColor;
}
`;

export const GLSL_FRAG_ANT = `${GLSL_HEADER}
in vec2 vLocal;
in vec4 vColor;
uniform float uOpacity;
out vec4 fragColor;

float ellipseDist(vec2 p, vec2 c, vec2 r) {
  return length((p - c) / r);
}

void main() {
  float head = ellipseDist(vLocal, vec2(0.60, 0.0), vec2(0.26, 0.22));
  float thorax = ellipseDist(vLocal, vec2(0.14, 0.0), vec2(0.22, 0.16));
  float gaster = ellipseDist(vLocal, vec2(-0.42, 0.0), vec2(0.38, 0.26));
  float d = min(min(head, thorax), gaster);

  float a = 1.0 - smoothstep(0.82, 1.0, d);
  if (a < 0.02) discard;
  float shade = 0.72 + 0.28 * (1.0 - vLocal.y * 0.5);
  fragColor = vec4(vColor.rgb * shade, a * vColor.a * uOpacity);
}
`;

export const GLSL_FRAG_MARKER = `${GLSL_HEADER}
in vec2 vLocal;
in vec4 vColor;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  float d = length(vLocal);
  if (d > 1.0) discard;
  float rim = smoothstep(1.0, 0.88, d);
  float core = 0.32 * smoothstep(1.0, 0.45, d);
  float a = max(rim, core) * vColor.a * uOpacity;
  fragColor = vec4(vColor.rgb, a);
}
`;

export const GLSL_PHERO_VERT = `${GLSL_HEADER}
uniform vec2 uResolution;
out vec2 vUv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  gl_Position = vec4(corner, 0.0, 1.0);
  vUv = (corner + 1.0) * 0.5;
}
`;

export const GLSL_PHERO_FRAG = `${GLSL_HEADER}
in vec2 vUv;
uniform vec2 uCenter;
uniform vec2 uResolution;
uniform float uZoom;
uniform float uIntensity;
uniform sampler2D uHome;
uniform sampler2D uFood;
const float WORLD_SIZE = 4096.0;
out vec4 fragColor;

void main() {
  vec2 sx = vec2((vUv.x * 2.0 - 1.0) * uResolution.x * 0.5,
                 -(vUv.y * 2.0 - 1.0) * uResolution.y * 0.5);
  vec2 world = uCenter + sx / uZoom;
  vec2 tuv = world / WORLD_SIZE;

  float home = texture(uHome, tuv).r;
  float food = texture(uFood, tuv).r;

  float h = smoothstep(0.03, 0.42, home) * uIntensity;
  float f = smoothstep(0.03, 0.42, food) * uIntensity;

  vec3 col = vec3(0.035, 0.040, 0.055);
  col += vec3(0.16, 0.38, 0.95) * h * 0.32;
  col += vec3(1.00, 0.48, 0.12) * f * 0.50;

  fragColor = vec4(col, 1.0);
}
`;
