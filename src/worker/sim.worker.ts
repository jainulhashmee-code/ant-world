/**
 * Simulation + render worker.
 *
 * One loop, one thread: fixed-step simulation, direct instance upload from the
 * agent pool, and rendering into a transferred OffscreenCanvas. Positions never
 * cross a thread boundary, so population costs nothing to display.
 */

/// <reference lib="webworker" />

import { Simulation } from '../sim/simulation';
import { createRenderer } from '../render/renderer';
import type { Renderer } from '../render/renderer';
import { WORLD, TICK_MS, MAX_CATCHUP } from '../core/config';
import type { Camera, MainToWorker, StatsPayload, WorkerToMain } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let renderer: Renderer | null = null;

let paused = false;
let speed = 1;
let camera: Camera = { centerX: WORLD / 2, centerY: WORLD / 2, zoom: 0.55 };
let width = 800;
let height = 600;

let accumulator = 0;
let lastFrame = performance.now();
let pheromoneCursor = 0;

/** Rolling frame-time window for p50/p95/p99. */
const FRAME_WINDOW = 180;
const frameTimes = new Float32Array(FRAME_WINDOW);
let frameCursor = 0;
let frameFilled = 0;

/**
 * Simulation CPU cost per tick, accumulated across the stats window.
 *
 * Deliberately NOT an exponential moving average of "milliseconds spent in the
 * sim this frame": at 8× speed one frame runs eight ticks, so a per-frame
 * number reports 8× the real cost and makes the engine look worse than it is.
 * Per tick is the number that answers "can this population hold 30 Hz".
 */
let simMsPerTick = 0;
let simWorkAccum = 0;
let renderMs = 0;
let lastStatsAt = 0;
let tickAtLastStats = 0;
let timeAtLastStats = performance.now();

// ---------------------------------------------------------------------------
// frame scheduling
// ---------------------------------------------------------------------------

/**
 * `requestAnimationFrame` is not guaranteed inside a worker, so fall back to a
 * deadline-aware timer that targets 60 Hz without busy-looping.
 */
const rafFn = (
  self as unknown as { requestAnimationFrame?: (cb: () => void) => number }
).requestAnimationFrame;

/**
 * Rendering is paced explicitly.
 *
 * Worker `requestAnimationFrame` is NOT throttled to the display refresh in
 * every browser — measured at 316 fps here, i.e. ~5× the work for frames nobody
 * can see. The gate lives in `schedule()` rather than in `frame()` so that a
 * too-early wakeup costs a timer, not a function call plus a stats update.
 */
const TARGET_FPS = 60;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

let nextFrameAt = 0;

function schedule(cb: () => void): void {
  const wait = nextFrameAt - performance.now();
  if (wait > 2) {
    setTimeout(cb, wait);
    return;
  }
  // Within the budget: align to the compositor if the browser offers it.
  if (rafFn) {
    rafFn(cb);
    return;
  }
  setTimeout(cb, Math.max(1, wait));
}

// ---------------------------------------------------------------------------
// input messages
// ---------------------------------------------------------------------------

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;

  switch (msg.type) {
    case 'init': {
      width = msg.width;
      height = msg.height;
      camera = msg.camera;
      boot(msg.canvas, msg.seed, msg.population);
      break;
    }
    case 'pause':
      paused = msg.value;
      break;
    case 'speed':
      speed = msg.value;
      break;
    case 'layers':
      renderer?.setLayers({
        pheromone: msg.pheromone,
        markers: msg.markers,
        ants: msg.ants,
      });
      break;
    case 'camera':
      camera = msg.camera;
      break;
    case 'resize':
      width = msg.width;
      height = msg.height;
      enforceMinZoom();
      renderer?.resize(width, height);
      break;
    case 'reset': {
      // A fresh Simulation re-registers its arrays; the old one is dropped.
      sim = new Simulation({ seed: msg.seed, population: msg.population });
      accumulator = 0;
      tickAtLastStats = 0;
      timeAtLastStats = performance.now();
      simWorkAccum = 0;
      simMsPerTick = 0;
      frameFilled = 0;
      frameCursor = 0;
      if (renderer) {
        renderer.setWorld(sim.world);
        renderer.uploadPheromone(
          sim.fields.home.data,
          sim.fields.food.data,
          sim.fields.home.size,
        );
      }
      post({
        type: 'ready',
        backend: renderer?.backend ?? 'webgl2',
        gpuInfo: renderer?.gpuInfo ?? 'unknown',
        seed: sim.seed,
        population: sim.agents.count,
        pheroSize: sim.fields.home.size,
      });
      break;
    }
  }
};

function post(msg: WorkerToMain): void {
  ctx.postMessage(msg);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot(canvas: OffscreenCanvas, seed: number, population: number): Promise<void> {
  try {
    renderer = await createRenderer(canvas);

    sim = new Simulation({ seed, population });
    enforceMinZoom();

    renderer.resize(width, height);
    renderer.setWorld(sim.world);
    renderer.uploadPheromone(sim.fields.home.data, sim.fields.food.data, sim.fields.home.size);

    post({
      type: 'ready',
      backend: renderer.backend,
      gpuInfo: renderer.gpuInfo,
      seed: sim.seed,
      population: sim.agents.count,
      pheroSize: sim.fields.home.size,
    });

    lastFrame = performance.now();
    schedule(frame);
  } catch (err) {
    // Anything thrown past renderer creation used to vanish into an unhandled
    // promise rejection, leaving a black screen with no message. One catch for
    // the whole boot path, reported to the UI.
    fail(err);
  }
}

/** Report a fatal worker error to the UI. */
function fail(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  post({ type: 'error', message });
  console.error('[ant-world] worker failure:', err);
}

// Unhandled rejections in a worker do not surface via `onerror`; without these
// two handlers a failure past this point is invisible in the UI.
ctx.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  fail((e as PromiseRejectionEvent).reason);
});
ctx.addEventListener('error', (e) => {
  fail((e as ErrorEvent).error ?? (e as ErrorEvent).message);
});

/** Never let the camera zoom out so far that the world is a speck. */
function enforceMinZoom(): void {
  const minZoom = Math.min(width, height) / (WORLD * 1.5);
  if (camera.zoom < minZoom) camera.zoom = minZoom;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function frame(): void {
  const t0 = performance.now();

  if (!sim || !renderer) {
    schedule(frame);
    return;
  }

  nextFrameAt = t0 + FRAME_INTERVAL_MS;

  // Wall-clock gap since the previous frame. This is the *interval*, which is
  // what "frame time" means to anyone reading the HUD — 16.7 ms is 60 fps.
  // It is deliberately not the work time: a loop that paces correctly spends
  // 3 ms of work inside a 16.7 ms interval, and reporting 1000/3 as "fps" is
  // how this panel said 340 fps while the screen was updating at 60.
  const interval = t0 - lastFrame;

  let dt = interval;
  lastFrame = t0;
  if (dt > 250) dt = 250; // tab was backgrounded; do not catch up 15 seconds

  if (!paused) {
    accumulator += dt * speed;
    const ts = performance.now();
    let ticks = 0;
    while (accumulator >= TICK_MS && ticks < MAX_CATCHUP) {
      sim.step();
      accumulator -= TICK_MS;
      ticks++;
    }
    if (ticks === MAX_CATCHUP) accumulator = 0; // drop the backlog, never spiral
    simWorkAccum += performance.now() - ts;
  }

  const rs = performance.now();
  renderer.uploadAgents(sim.agents, sim.agents.count);
  // Pheromone changes slowly; upload at ~15 Hz instead of every frame.
  if (pheromoneCursor++ % 4 === 0) {
    renderer.uploadPheromone(sim.fields.home.data, sim.fields.food.data, sim.fields.home.size);
  }
  renderer.render(camera);
  renderMs = renderMs * 0.9 + (performance.now() - rs) * 0.1;

  // ---- frame statistics ---------------------------------------------------
  // Clamped like `dt`: a backgrounded tab produces one 15-second "frame" that
  // would otherwise poison p99 for the next three seconds of real data.
  frameTimes[frameCursor] = Math.min(interval, 250);
  frameCursor = (frameCursor + 1) % FRAME_WINDOW;
  if (frameFilled < FRAME_WINDOW) frameFilled++;

  const now = performance.now();
  if (now - lastStatsAt > 250) {
    lastStatsAt = now;
    postStats(now);
  }

  schedule(frame);
}

function postStats(now: number): void {
  if (!sim || !renderer) return;

  const sorted = Array.from(frameTimes.subarray(0, frameFilled)).sort((a, b) => a - b);
  const pick = (q: number): number => {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[i];
  };

  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 16.7;

  const elapsed = (now - timeAtLastStats) / 1000;
  const ticks = sim.tick - tickAtLastStats;
  const tps = elapsed > 0 ? ticks / elapsed : 0;
  tickAtLastStats = sim.tick;
  timeAtLastStats = now;

  // Cost per tick over the whole window, not per frame: a frame at 8× speed
  // runs eight ticks and would otherwise report eight times the true cost.
  if (ticks > 0) simMsPerTick = simWorkAccum / ticks;
  simWorkAccum = 0;

  const s = sim.stats();
  const stats: StatsPayload = {
    fps: avg > 0 ? 1000 / avg : 0,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    simMs: simMsPerTick,
    renderMs,
    tick: s.tick,
    population: s.population,
    updatesPerSec: tps * s.population,
    delivered: s.delivered,
    deliveries: s.deliveries,
    revivals: s.revivals,
    seeking: s.seeking,
    returning: s.returning,
    foodRemaining: s.foodRemaining,
    memMB: s.memMB,
    paused,
    speed,
  };
  post({ type: 'stats', stats });
}
