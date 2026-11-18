/**
 * HUD — the only thing the main thread does at runtime besides input.
 *
 * Every number here comes from a `stats` message measured inside the worker,
 * so what is displayed is what actually happened.
 */

import type { StatsPayload } from '../worker/protocol';

/**
 * The sim runs at a fixed 30 Hz. "Updates/s" alone says nothing — 300K/s is
 * perfect at 10,000 agents and terrible at 100,000. What matters is whether the
 * simulation is holding its 30 steps per second, so that is what gets coloured.
 */
const SIM_HZ = 30;

/** Frame budget. Past 60 Hz pacing, p95 can never come in under 16.7 ms. */
const FRAME_BUDGET = 1000 / 60;

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function ms(n: number): string {
  return `${n.toFixed(2)} ms`;
}

function millions(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return int(n);
}

export class Hud {
  private readonly fps = el('s-fps');
  private readonly p50 = el('s-p50');
  private readonly p95 = el('s-p95');
  private readonly p99 = el('s-p99');
  private readonly pop = el('s-pop');
  private readonly ups = el('s-ups');
  private readonly tick = el('s-tick');
  private readonly simms = el('s-simms');
  private readonly renms = el('s-renms');
  private readonly mem = el('s-mem');
  private readonly trips = el('s-trips');
  private readonly ret = el('s-ret');
  private readonly food = el('s-food');
  private readonly backend = el('backend');

  setBackend(backend: string, gpuInfo: string, pheroSize: number): void {
    this.backend.textContent = `${backend} · ${gpuInfo.split('·')[1]?.trim() ?? ''} · field ${pheroSize}²`;
  }

  update(s: StatsPayload): void {
    this.fps.textContent = s.fps.toFixed(0);

    // Report p50 too, but colour the p95 against the frame budget: a good p50
    // with a bad p95 is a stuttering simulation, and hiding that is dishonest.
    // The tolerance is one sixth of a frame of timer jitter, because a paced
    // loop lands a millisecond either side of the interval on every frame.
    this.p50.textContent = ms(s.p50);
    this.p95.textContent = ms(s.p95);
    this.p95.className = `v ${
      s.p95 <= FRAME_BUDGET * 1.15 ? 'good' : s.p95 <= FRAME_BUDGET * 1.5 ? 'amber' : 'bad'
    }`;
    this.p99.textContent = ms(s.p99);
    this.p99.className = `v ${
      s.p99 <= FRAME_BUDGET * 1.5 ? 'good' : s.p99 <= FRAME_BUDGET * 2.4 ? 'amber' : 'bad'
    }`;

    this.pop.textContent = int(s.population);
    // Can the simulation hold real time at this population?
    const held = s.updatesPerSec / (s.population * SIM_HZ);
    this.ups.textContent = `${millions(s.updatesPerSec)}/s`;
    this.ups.className = `v ${held >= 0.95 ? 'good' : held >= 0.6 ? 'amber' : 'bad'}`;
    this.tick.textContent = int(s.tick);
    // The whole sim budget is one tick: 1000/30 = 33.3 ms. Past that the
    // simulation cannot hold its fixed step, whatever the frame rate says.
    this.simms.textContent = ms(s.simMs);
    this.simms.className = `v ${s.simMs <= 33.3 ? 'good' : s.simMs <= 50 ? 'amber' : 'bad'}`;
    this.renms.textContent = ms(s.renderMs);
    this.mem.textContent = `${s.memMB.toFixed(2)} MB`;
    this.mem.className = `v ${s.memMB <= 10 ? '' : 'bad'}`;

    this.trips.textContent = int(s.deliveries);
    this.ret.textContent = int(s.returning);
    this.food.textContent = int(s.foodRemaining);
  }

  showBootError(message: string): void {
    const boot = document.getElementById('boot');
    if (boot) boot.classList.add('hidden');
    const box = document.getElementById('error');
    if (box) {
      box.style.display = 'block';
      box.textContent = message;
    }
  }

  hideBoot(): void {
    document.getElementById('boot')?.classList.add('hidden');
  }
}
