/**
 * Main thread ⇄ worker protocol.
 *
 * The main thread owns the DOM and input. It sends control messages and
 * receives stats — nothing else crosses the boundary, because the renderer
 * lives in the worker and reads simulation memory directly.
 */

export interface Camera {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface InitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  seed: number;
  population: number;
  width: number;
  height: number;
  camera: Camera;
}

export type MainToWorker =
  | InitMessage
  | { type: 'pause'; value: boolean }
  | { type: 'speed'; value: number }
  | { type: 'layers'; pheromone: boolean; markers: boolean; ants: boolean }
  | { type: 'camera'; camera: Camera }
  | { type: 'resize'; width: number; height: number }
  | { type: 'reset'; seed: number; population: number };

export interface StatsPayload {
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  simMs: number;
  renderMs: number;
  tick: number;
  population: number;
  updatesPerSec: number;
  delivered: number;
  deliveries: number;
  revivals: number;
  seeking: number;
  returning: number;
  foodRemaining: number;
  memMB: number;
  paused: boolean;
  speed: number;
}

export type WorkerToMain =
  | {
      type: 'ready';
      backend: 'webgpu' | 'webgl2';
      gpuInfo: string;
      seed: number;
      population: number;
      pheroSize: number;
    }
  | { type: 'stats'; stats: StatsPayload }
  | { type: 'error'; message: string };
