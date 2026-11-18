/**
 * WebGPU backend.
 *
 * Three draws per frame in one render pass:
 *   1. pheromone field      — fullscreen quad, two R8 textures
 *   2. markers              — instanced circles (nest, food, rocks)
 *   3. ants                 — instanced quads, procedural body in the shader
 *
 * No depth buffer, no MSAA, no per-frame pipeline creation.
 */

import { WGSL_AGENTS, WGSL_PHERO } from './shaders';
import { InstanceBuffer } from './instances';
import { ATTR_COLOR, ATTR_DIR, ATTR_POS, ATTR_SIZE, INSTANCE_BYTES } from './layout';
import { ANT_SIZE, DEFAULT_LAYERS } from './renderer';
import type { Layers, Renderer, ViewState } from './renderer';
import type { AgentPool } from '../sim/agents';
import type { World } from '../sim/world';

const BG: GPUColor = { r: 0.035, g: 0.04, b: 0.055, a: 1 };

const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: INSTANCE_BYTES,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: ATTR_POS, format: 'float32x2' },
    { shaderLocation: 1, offset: ATTR_DIR, format: 'float32x2' },
    { shaderLocation: 2, offset: ATTR_COLOR, format: 'unorm8x4' },
    { shaderLocation: 3, offset: ATTR_SIZE, format: 'float32' },
  ],
};

const BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class WebGPURenderer implements Renderer {
  readonly backend = 'webgpu' as const;
  gpuInfo = 'WebGPU';

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: OffscreenCanvas;

  private readonly antInstances: InstanceBuffer;
  private readonly markerInstances: InstanceBuffer;

  private readonly antBuffer: GPUBuffer;
  private readonly markerBuffer: GPUBuffer;

  private readonly antPipe: GPURenderPipeline;
  private readonly markerPipe: GPURenderPipeline;
  private readonly pheroPipe: GPURenderPipeline;

  private readonly antUniform: GPUBuffer;
  private readonly markerUniform: GPUBuffer;
  private readonly pheroUniform: GPUBuffer;

  private readonly antBind: GPUBindGroup;
  private readonly markerBind: GPUBindGroup;
  private pheroBind: GPUBindGroup | null = null;

  private homeTex: GPUTexture | null = null;
  private foodTex: GPUTexture | null = null;
  private texSize = 0;
  private readonly sampler: GPUSampler;
  private readonly pheroBindLayout: GPUBindGroupLayout;

  private width = 1;
  private height = 1;
  private antCount = 0;
  private markerCount = 0;
  private layers: Layers = { ...DEFAULT_LAYERS };

  /** Reused every frame for uniform uploads — no per-frame allocation. */
  private readonly scratch = new Float32Array(8);

  private constructor(
    canvas: OffscreenCanvas,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    antCapacity: number,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;

    this.antInstances = new InstanceBuffer(antCapacity);
    this.markerInstances = new InstanceBuffer(512);

    this.antBuffer = device.createBuffer({
      size: Math.max(INSTANCE_BYTES, antCapacity * INSTANCE_BYTES),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.markerBuffer = device.createBuffer({
      size: 512 * INSTANCE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const agentModule = device.createShaderModule({ code: WGSL_AGENTS, label: 'agents' });
    const pheroModule = device.createShaderModule({ code: WGSL_PHERO, label: 'phero' });

    const camLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });

    this.pheroBindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const makeAgentPipeline = (entryPoint: string, label: string): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [camLayout] }),
        vertex: { module: agentModule, entryPoint: 'vs_main', buffers: [VERTEX_LAYOUT] },
        fragment: {
          module: agentModule,
          entryPoint,
          targets: [{ format, blend: BLEND }],
        },
        primitive: { topology: 'triangle-strip' },
      });

    this.antPipe = makeAgentPipeline('fs_ant', 'ant');
    this.markerPipe = makeAgentPipeline('fs_marker', 'marker');

    this.pheroPipe = device.createRenderPipeline({
      label: 'phero',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.pheroBindLayout] }),
      vertex: { module: pheroModule, entryPoint: 'vs_main' },
      fragment: { module: pheroModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });

    this.antUniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.markerUniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pheroUniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.antBind = device.createBindGroup({
      layout: camLayout,
      entries: [{ binding: 0, resource: { buffer: this.antUniform } }],
    });
    this.markerBind = device.createBindGroup({
      layout: camLayout,
      entries: [{ binding: 0, resource: { buffer: this.markerUniform } }],
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  static async create(canvas: OffscreenCanvas, gpu: GPU): Promise<WebGPURenderer> {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');

    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('no webgpu context');

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    // Capacity for the largest population the engine supports.
    const r = new WebGPURenderer(canvas, device, context, format, 100_000);
    const info = adapter.info as { vendor?: string; architecture?: string; device?: string } | undefined;
    r.gpuInfo = `WebGPU · ${info?.vendor ?? 'gpu'}${info?.architecture ? ` ${info.architecture}` : ''}`;
    return r;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
  }

  setWorld(world: World): void {
    this.markerCount = this.markerInstances.writeMarkers(world);
    this.device.queue.writeBuffer(
      this.markerBuffer,
      0,
      this.markerInstances.ab,
      0,
      this.markerCount * INSTANCE_BYTES,
    );
  }

  setLayers(layers: Layers): void {
    this.layers = { ...layers };
  }

  uploadPheromone(
    home: Uint8Array<ArrayBuffer>,
    food: Uint8Array<ArrayBuffer>,
    size: number,
  ): void {
    if (this.texSize !== size) this.createPheroTextures(size);

    const extent = { width: size, height: size };
    this.device.queue.writeTexture(
      { texture: this.homeTex! },
      home,
      { bytesPerRow: size, rowsPerImage: size },
      extent,
    );
    this.device.queue.writeTexture(
      { texture: this.foodTex! },
      food,
      { bytesPerRow: size, rowsPerImage: size },
      extent,
    );
  }

  private createPheroTextures(size: number): void {
    this.homeTex?.destroy();
    this.foodTex?.destroy();
    this.texSize = size;

    const make = (label: string): GPUTexture =>
      this.device.createTexture({
        label,
        size: { width: size, height: size },
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

    this.homeTex = make('phero-home');
    this.foodTex = make('phero-food');

    this.pheroBind = this.device.createBindGroup({
      layout: this.pheroBindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pheroUniform } },
        { binding: 1, resource: this.homeTex.createView() },
        { binding: 2, resource: this.foodTex.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  uploadAgents(pool: AgentPool, count: number): void {
    this.antCount = this.antInstances.writeAnts(pool, count);
    this.device.queue.writeBuffer(
      this.antBuffer,
      0,
      this.antInstances.ab,
      0,
      this.antCount * INSTANCE_BYTES,
    );
  }

  render(view: ViewState): void {
    const s = this.scratch;

    s[0] = view.centerX;
    s[1] = view.centerY;
    s[2] = this.width;
    s[3] = this.height;
    s[4] = view.zoom;
    s[5] = ANT_SIZE;
    s[6] = 1;
    s[7] = 0;
    this.device.queue.writeBuffer(this.antUniform, 0, s);

    // Markers use world-unit sizes directly, so their scale uniform is 1.
    s[5] = 1;
    this.device.queue.writeBuffer(this.markerUniform, 0, s);

    s[5] = 1; // pheromone intensity
    this.device.queue.writeBuffer(this.pheroUniform, 0, s);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: BG,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    if (this.layers.pheromone && this.pheroBind) {
      pass.setPipeline(this.pheroPipe);
      pass.setBindGroup(0, this.pheroBind);
      pass.draw(4);
    }

    if (this.layers.markers && this.markerCount > 0) {
      pass.setPipeline(this.markerPipe);
      pass.setBindGroup(0, this.markerBind);
      pass.setVertexBuffer(0, this.markerBuffer);
      pass.draw(4, this.markerCount);
    }

    if (this.layers.ants && this.antCount > 0) {
      pass.setPipeline(this.antPipe);
      pass.setBindGroup(0, this.antBind);
      pass.setVertexBuffer(0, this.antBuffer);
      pass.draw(4, this.antCount);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.homeTex?.destroy();
    this.foodTex?.destroy();
    this.antBuffer.destroy();
    this.markerBuffer.destroy();
    this.device.destroy();
  }
}
