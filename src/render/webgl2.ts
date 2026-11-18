/**
 * WebGL2 backend — the fallback that must always work.
 *
 * Same three draws, same 24-byte instance layout, same procedural ant body as
 * the WebGPU path. Instanced arrays via `vertexAttribDivisor`; no extensions
 * required beyond core WebGL2.
 */

import {
  GLSL_ANT_HEADER,
  GLSL_FRAG_ANT,
  GLSL_FRAG_MARKER,
  GLSL_PHERO_FRAG,
  GLSL_PHERO_VERT,
} from './shaders';
import { InstanceBuffer } from './instances';
import { ATTR_COLOR, ATTR_DIR, ATTR_POS, ATTR_SIZE, INSTANCE_BYTES } from './layout';
import { ANT_SIZE, DEFAULT_LAYERS } from './renderer';
import type { Layers, Renderer, ViewState } from './renderer';
import type { AgentPool } from '../sim/agents';
import type { World } from '../sim/world';

type Uniforms = Record<string, WebGLUniformLocation | null>;

export class WebGL2Renderer implements Renderer {
  readonly backend = 'webgl2' as const;
  gpuInfo = 'WebGL2';

  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: OffscreenCanvas;

  private readonly antProg: WebGLProgram;
  private readonly markerProg: WebGLProgram;
  private readonly pheroProg: WebGLProgram;

  private readonly antU: Uniforms;
  private readonly markerU: Uniforms;
  private readonly pheroU: Uniforms;

  private readonly antInstances: InstanceBuffer;
  private readonly markerInstances: InstanceBuffer;

  private readonly antBuf: WebGLBuffer;
  private readonly markerBuf: WebGLBuffer;
  private readonly antVao: WebGLVertexArrayObject;
  private readonly markerVao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;

  private homeTex: WebGLTexture | null = null;
  private foodTex: WebGLTexture | null = null;
  private texSize = 0;

  private width = 1;
  private height = 1;
  private antCount = 0;
  private markerCount = 0;
  private layers: Layers = { ...DEFAULT_LAYERS };

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext, antCapacity: number) {
    this.canvas = canvas;
    this.gl = gl;

    const vsAnt = compile(gl, gl.VERTEX_SHADER, GLSL_ANT_HEADER);
    this.antProg = link(gl, vsAnt, compile(gl, gl.FRAGMENT_SHADER, GLSL_FRAG_ANT));
    this.markerProg = link(gl, vsAnt, compile(gl, gl.FRAGMENT_SHADER, GLSL_FRAG_MARKER));
    const vsPhero = compile(gl, gl.VERTEX_SHADER, GLSL_PHERO_VERT);
    this.pheroProg = link(gl, vsPhero, compile(gl, gl.FRAGMENT_SHADER, GLSL_PHERO_FRAG));

    this.antU = uniforms(gl, this.antProg, [
      'uCenter',
      'uResolution',
      'uZoom',
      'uAntSize',
      'uOpacity',
    ]);
    this.markerU = uniforms(gl, this.markerProg, [
      'uCenter',
      'uResolution',
      'uZoom',
      'uAntSize',
      'uOpacity',
    ]);
    this.pheroU = uniforms(gl, this.pheroProg, [
      'uCenter',
      'uResolution',
      'uZoom',
      'uIntensity',
      'uHome',
      'uFood',
    ]);

    this.antInstances = new InstanceBuffer(antCapacity);
    this.markerInstances = new InstanceBuffer(512);

    const ant = createInstanceVao(gl, antCapacity * INSTANCE_BYTES);
    this.antBuf = ant.buffer;
    this.antVao = ant.vao;

    const marker = createInstanceVao(gl, 512 * INSTANCE_BYTES);
    this.markerBuf = marker.buffer;
    this.markerVao = marker.vao;

    this.emptyVao = gl.createVertexArray()!;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.035, 0.04, 0.055, 1);

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const name = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
      this.gpuInfo = `WebGL2 · ${name}`;
    }
  }

  static create(canvas: OffscreenCanvas): WebGL2Renderer {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    return new WebGL2Renderer(canvas, gl, 100_000);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
    this.gl.viewport(0, 0, this.width, this.height);
  }

  setWorld(world: World): void {
    this.markerCount = this.markerInstances.writeMarkers(world);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.markerInstances.f32, 0, this.markerCount * 6);
  }

  setLayers(layers: Layers): void {
    this.layers = { ...layers };
  }

  uploadPheromone(home: Uint8Array, food: Uint8Array, size: number): void {
    const gl = this.gl;
    if (this.texSize !== size) {
      if (this.homeTex) gl.deleteTexture(this.homeTex);
      if (this.foodTex) gl.deleteTexture(this.foodTex);
      this.homeTex = makeTexture(gl, size);
      this.foodTex = makeTexture(gl, size);
      this.texSize = size;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.homeTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, home);
    gl.bindTexture(gl.TEXTURE_2D, this.foodTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, food);
  }

  uploadAgents(pool: AgentPool, count: number): void {
    this.antCount = this.antInstances.writeAnts(pool, count);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.antBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.antInstances.f32, 0, this.antCount * 6);
  }

  render(view: ViewState): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.layers.pheromone && this.homeTex && this.foodTex) {
      gl.useProgram(this.pheroProg);
      gl.uniform2f(this.pheroU.uCenter, view.centerX, view.centerY);
      gl.uniform2f(this.pheroU.uResolution, this.width, this.height);
      gl.uniform1f(this.pheroU.uZoom, view.zoom);
      gl.uniform1f(this.pheroU.uIntensity, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.homeTex);
      gl.uniform1i(this.pheroU.uHome, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.foodTex);
      gl.uniform1i(this.pheroU.uFood, 1);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (this.layers.markers && this.markerCount > 0) {
      gl.useProgram(this.markerProg);
      gl.uniform2f(this.markerU.uCenter, view.centerX, view.centerY);
      gl.uniform2f(this.markerU.uResolution, this.width, this.height);
      gl.uniform1f(this.markerU.uZoom, view.zoom);
      gl.uniform1f(this.markerU.uAntSize, 1);
      gl.uniform1f(this.markerU.uOpacity, 1);
      gl.bindVertexArray(this.markerVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.markerCount);
    }

    if (this.layers.ants && this.antCount > 0) {
      gl.useProgram(this.antProg);
      gl.uniform2f(this.antU.uCenter, view.centerX, view.centerY);
      gl.uniform2f(this.antU.uResolution, this.width, this.height);
      gl.uniform1f(this.antU.uZoom, view.zoom);
      gl.uniform1f(this.antU.uAntSize, ANT_SIZE);
      gl.uniform1f(this.antU.uOpacity, 1);
      gl.bindVertexArray(this.antVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.antCount);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.antProg);
    gl.deleteProgram(this.markerProg);
    gl.deleteProgram(this.pheroProg);
    gl.deleteBuffer(this.antBuf);
    gl.deleteBuffer(this.markerBuf);
    gl.deleteVertexArray(this.antVao);
    gl.deleteVertexArray(this.markerVao);
    gl.deleteVertexArray(this.emptyVao);
    if (this.homeTex) gl.deleteTexture(this.homeTex);
    if (this.foodTex) gl.deleteTexture(this.foodTex);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const out: Uniforms = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

function makeTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  return t;
}

/** Creates an instance buffer + VAO pair wired for 24-byte interleaved data. */
function createInstanceVao(
  gl: WebGL2RenderingContext,
  byteLength: number,
): { buffer: WebGLBuffer; vao: WebGLVertexArrayObject } {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_BYTES, ATTR_POS);
  gl.vertexAttribDivisor(0, 1);

  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, INSTANCE_BYTES, ATTR_DIR);
  gl.vertexAttribDivisor(1, 1);

  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, ATTR_COLOR);
  gl.vertexAttribDivisor(2, 1);

  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, INSTANCE_BYTES, ATTR_SIZE);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(null);
  return { buffer, vao };
}
