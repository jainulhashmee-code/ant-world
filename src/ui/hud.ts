/**
 * HUD — the only thing the main thread does at runtime besides input.
 *
 * Every number here comes from a `stats` message measured inside the worker,
 * so what is displayed is what actually happened.
 */

import type { StatsPayload } from '../worker/protocol';

const TARGET_UPDATES = 3_000_000;

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

    // Report p50 too, but colour the p95 against the 16.7 ms budget: a good p50
    // with a bad p95 is a stuttering simulation, and hiding that is dishonest.
    this.p50.textContent = ms(s.p50);
    this.p95.textContent = ms(s.p95);
    this.p95.className = `v ${s.p95 <= 16.7 ? 'good' : s.p95 <= 25 ? 'amber' : 'bad'}`;
    this.p99.textContent = ms(s.p99);
    this.p99.className = `v ${s.p99 <= 25 ? 'good' : s.p99 <= 40 ? 'amber' : 'bad'}`;

    this.pop.textContent = int(s.population);
    this.ups.textContent = `${millions(s.updatesPerSec)}/s`;
    this.ups.className = `v ${s.updatesPerSec >= TARGET_UPDATES ? 'good' : 'amber'}`;
    this.tick.textContent = int(s.tick);
    this.simms.textContent = ms(s.simMs);
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
