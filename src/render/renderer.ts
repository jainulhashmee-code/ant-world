/**
 * Renderer abstraction + backend selection.
 *
 * WebGPU is preferred; WebGL2 is the fallback. Both consume the identical
 * 24-byte instance buffer, so nothing above this file knows which one is live.
 */

import type { AgentPool } from '../sim/agents';
import type { World } from '../sim/world';
import { WebGPURenderer } from './webgpu';
import { WebGL2Renderer } from './webgl2';

export interface ViewState {
  centerX: number;
  centerY: number;
  zoom: number; // pixels per world unit
}

export interface Layers {
  pheromone: boolean;
  markers: boolean;
  ants: boolean;
}

export interface Renderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly gpuInfo: string;
  resize(width: number, height: number): void;
  setWorld(world: World): void;
  setLayers(layers: Layers): void;
  uploadPheromone(
    home: Uint8Array<ArrayBuffer>,
    food: Uint8Array<ArrayBuffer>,
    size: number,
  ): void;
  uploadAgents(pool: AgentPool, count: number): void;
  render(view: ViewState): void;
  dispose(): void;
}

/** Ant body length in world units (before the camera zoom). */
export const ANT_SIZE = 9;

export const DEFAULT_LAYERS: Layers = {
  pheromone: true,
  markers: true,
  ants: true,
};

/**
 * Bound every GPU handshake.
 *
 * `requestAdapter()` can hang forever on a bad driver or in a browser that
 * exposes `navigator.gpu` but has no usable device. Without this the worker
 * never reports ready and the user gets a permanent black screen with no error.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Create a renderer on an OffscreenCanvas, preferring WebGPU.
 *
 * Failure is expected and handled: Safari and older Chromium have no WebGPU.
 */
export async function createRenderer(canvas: OffscreenCanvas): Promise<Renderer> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;

  if (gpu) {
    try {
      return await withTimeout(WebGPURenderer.create(canvas, gpu), 4000, 'WebGPU init');
    } catch (err) {
      console.warn('[ant-world] WebGPU unavailable, falling back to WebGL2:', err);
    }
  }

  return WebGL2Renderer.create(canvas);
}
