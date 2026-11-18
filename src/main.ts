/**
 * Main thread bootstrap.
 *
 * Owns the DOM, input and URL. The canvas is transferred to the worker, which
 * both simulates and renders — so this file does almost nothing per frame,
 * which is exactly why the UI stays responsive at 100,000 agents.
 */

import { Hud } from './ui/hud';
import { WORLD } from './core/config';
import type { Camera, MainToWorker, StatsPayload, WorkerToMain } from './worker/protocol';

const params = new URLSearchParams(location.search);

const seed = Number(params.get('seed') ?? 42) >>> 0;
const population = clampPop(Number(params.get('ants') ?? 10_000));

const canvas = document.getElementById('world') as HTMLCanvasElement;
const hud = new Hud();

const dpr = Math.min(window.devicePixelRatio || 1, 2);
let width = Math.floor(window.innerWidth * dpr);
let height = Math.floor(window.innerHeight * dpr);

const camera: Camera = {
  centerX: WORLD / 2,
  centerY: WORLD / 2,
  zoom: Math.min(window.innerWidth, window.innerHeight) / 1500,
};

function clampPop(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(100_000, Math.round(n));
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let paused = false;
let speed = 1;

function send(msg: MainToWorker): void {
  worker?.postMessage(msg);
}

function start(): void {
  if (!('transferControlToOffscreen' in canvas)) {
    hud.showBootError(
      'This browser has no OffscreenCanvas, so the simulation cannot run in a worker.\n' +
        'Try a current Chrome, Edge, Firefox or Safari.',
    );
    return;
  }

  worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      hud.setBackend(msg.backend, msg.gpuInfo, msg.pheroSize);
      hud.hideBoot();
      document.title = `Ant World — ${msg.population.toLocaleString('en-US')} ants`;
    } else if (msg.type === 'stats') {
      lastStats = msg.stats;
      hud.update(msg.stats);
      paused = msg.stats.paused;
      syncPauseButton();
    } else if (msg.type === 'error') {
      hud.showBootError(msg.message);
    }
  };

  worker.onerror = (e) => {
    hud.showBootError(`worker error: ${e.message || 'unknown'}`);
  };

  const offscreen = canvas.transferControlToOffscreen();
  send({ type: 'init', canvas: offscreen, seed, population, width, height, camera });
}

// ---------------------------------------------------------------------------
// input: pan, zoom, resize
// ---------------------------------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;

  // Pan in world units at the current zoom, so dragging tracks the cursor.
  camera.centerX -= (dx * dpr) / camera.zoom;
  camera.centerY -= (dy * dpr) / camera.zoom;
  clampCamera();
  send({ type: 'camera', camera });
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('dragging');
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    // Zoom about the cursor: the world point under the pointer stays put.
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(6, Math.max(0.02, camera.zoom * factor));

    const px = (e.clientX - window.innerWidth / 2) * dpr;
    const py = (e.clientY - window.innerHeight / 2) * dpr;
    const before = camera.zoom;
    const ratio = 1 / next - 1 / before;
    camera.centerX += px * ratio;
    camera.centerY += py * ratio;
    camera.zoom = next;

    clampCamera();
    send({ type: 'camera', camera });
  },
  { passive: false },
);

function clampCamera(): void {
  // Keep the view near the world; a little overscan is fine and feels better.
  const pad = WORLD * 0.25;
  camera.centerX = Math.min(WORLD + pad, Math.max(-pad, camera.centerX));
  camera.centerY = Math.min(WORLD + pad, Math.max(-pad, camera.centerY));
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    width = Math.floor(window.innerWidth * dpr);
    height = Math.floor(window.innerHeight * dpr);
    send({ type: 'resize', width, height });
  }, 120);
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

const btnPause = document.getElementById('btn-pause')!;
const btnSpeed = document.getElementById('btn-speed')!;
const btnPhero = document.getElementById('btn-phero')!;
const btnMarkers = document.getElementById('btn-markers')!;
const btnReset = document.getElementById('btn-reset')!;
const selPop = document.getElementById('sel-pop') as HTMLSelectElement;

function syncPauseButton(): void {
  btnPause.textContent = paused ? 'Resume' : 'Pause';
  btnPause.classList.toggle('on', paused);
}

btnPause.addEventListener('click', () => {
  paused = !paused;
  send({ type: 'pause', value: paused });
  syncPauseButton();
});

const SPEEDS = [1, 2, 4, 8];
btnSpeed.addEventListener('click', () => {
  const i = (SPEEDS.indexOf(speed) + 1) % SPEEDS.length;
  speed = SPEEDS[i];
  btnSpeed.textContent = `${speed}×`;
  btnSpeed.classList.toggle('on', speed !== 1);
  send({ type: 'speed', value: speed });
});

let showPhero = true;
btnPhero.addEventListener('click', () => {
  showPhero = !showPhero;
  btnPhero.classList.toggle('on', showPhero);
  sendLayers();
});

let showMarkers = true;
btnMarkers.addEventListener('click', () => {
  showMarkers = !showMarkers;
  btnMarkers.classList.toggle('on', showMarkers);
  sendLayers();
});

function sendLayers(): void {
  send({ type: 'layers', pheromone: showPhero, markers: showMarkers, ants: true });
}

let currentSeed = seed;
btnReset.addEventListener('click', () => {
  currentSeed = (currentSeed * 1664525 + 1013904223) >>> 0;
  const pop = clampPop(Number(selPop.value));
  history.replaceState(null, '', `?seed=${currentSeed}&ants=${pop}`);
  send({ type: 'reset', seed: currentSeed, population: pop });
});

selPop.value = String(population);
selPop.addEventListener('change', () => {
  const pop = clampPop(Number(selPop.value));
  history.replaceState(null, '', `?seed=${currentSeed}&ants=${pop}`);
  send({ type: 'reset', seed: currentSeed, population: pop });
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    btnPause.click();
  } else if (e.key === 'p') {
    btnPhero.click();
  } else if (e.key === 't') {
    btnMarkers.click();
  } else if (e.key === 'r') {
    btnReset.click();
  }
});

// ---------------------------------------------------------------------------
// go
// ---------------------------------------------------------------------------

let lastStats: StatsPayload | null = null;

syncPauseButton();
start();

// Small debugging handle; also what a benchmark export reads.
(window as unknown as { antWorld: unknown }).antWorld = {
  get stats(): StatsPayload | null {
    return lastStats;
  },
};
