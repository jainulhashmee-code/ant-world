/**
 * Pheromone fields.
 *
 * Two 8-bit channels — HOME and FOOD — maintained with integer maths only:
 *
 *   decay:    v -= v >> DECAY_SHIFT          (≈1.6% per field update)
 *   diffuse:  v' = (4v + N + S + E + W) >> 3 (normalised 4-neighbour blur)
 *
 * Integer-only matters for two reasons: it is faster than float, and it makes
 * the result bit-identical if this pass ever moves to another worker or into a
 * WebGPU compute shader.
 *
 * Resolution scales with population (see `resolveResolution`), so the memory
 * line on the HUD is honest at 100 ants and at 100,000.
 */

import { mem } from '../core/memory';
import { DECAY_SHIFT, PHERO_MAX } from '../core/config';

export class PheromoneField {
  readonly size: number;
  readonly invCell: number;

  /**
   * Current field. The reference is stable for the lifetime of the field —
   * the renderer uploads this exact array, so it must never be swapped.
   */
  readonly data: Uint8Array<ArrayBuffer>;
  /** Blur destination. Shared between channels; see `PheromoneSet`. */
  private readonly scratch: Uint8Array<ArrayBuffer>;

  constructor(
    label: string,
    size: number,
    worldSize: number,
    scratch: Uint8Array<ArrayBuffer>,
  ) {
    this.size = size;
    this.invCell = size / worldSize;
    this.data = mem.u8(`phero.${label}`, size * size);
    this.scratch = scratch;
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Saturating add at the cell containing a world position. */
  depositWorld(wx: number, wy: number, amount: number): void {
    const size = this.size;
    const gx = (wx * this.invCell) | 0;
    const gy = (wy * this.invCell) | 0;
    if (gx < 0 || gy < 0 || gx >= size || gy >= size) return;
    const i = gy * size + gx;
    const d = this.data;
    const v = d[i] + amount;
    d[i] = v > PHERO_MAX ? PHERO_MAX : v;
  }

  /** Bilinear sample at a world position. Out of bounds reads as 0. */
  sampleWorld(wx: number, wy: number): number {
    const size = this.size;
    const gx = wx * this.invCell;
    const gy = wy * this.invCell;

    let cx = gx | 0;
    let cy = gy | 0;

    if (cx < 0 || cy < 0 || cx >= size - 1 || cy >= size - 1) {
      // Clamp to the nearest valid cell; outside the world there is no signal.
      if (gx < 0 || gy < 0 || gx >= size || gy >= size) return 0;
      if (cx > size - 1) cx = size - 1;
      if (cy > size - 1) cy = size - 1;
      return this.data[cy * size + cx];
    }

    const tx = gx - cx;
    const ty = gy - cy;
    const d = this.data;
    const i = cy * size + cx;
    const a = d[i];
    const b = d[i + 1];
    const c = d[i + size];
    const e = d[i + size + 1];
    const top = a + (b - a) * tx;
    const bot = c + (e - c) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * One decay + diffusion pass. ~1M cell ops at 1024², run at 4 Hz.
   *
   * Decay runs in place; diffusion writes into the scratch buffer and is then
   * copied back, so the blur never reads a partially-updated neighbour and the
   * public `data` reference stays stable.
   */
  update(): void {
    const d = this.data;
    const s = this.scratch;
    const n = this.size;
    const total = n * n;

    // Pass 1 — exponential decay, in place.
    for (let i = 0; i < total; i++) {
      const v = d[i];
      d[i] = v - (v >> DECAY_SHIFT);
    }

    // Pass 2 — 4-neighbour blur. Borders carry through unblurred.
    s.set(d);
    const last = n - 1;
    for (let y = 1; y < last; y++) {
      const row = y * n;
      for (let x = 1; x < last; x++) {
        const i = row + x;
        s[i] = (d[i - 1] + d[i + 1] + d[i - n] + d[i + n] + (d[i] << 2)) >> 3;
      }
    }

    d.set(s);
  }
}

/**
 * Both channels plus the single shared scratch buffer.
 *
 * One 1 MB scratch serves both channels: each `update()` overwrites it
 * completely before reading, so sharing is safe and the pair costs
 * 3 × resolution bytes instead of 4.
 */
export class PheromoneSet {
  readonly home: PheromoneField;
  readonly food: PheromoneField;

  constructor(size: number, worldSize: number) {
    const scratch = mem.u8('phero.scratch', size * size);
    this.home = new PheromoneField('home', size, worldSize, scratch);
    this.food = new PheromoneField('food', size, worldSize, scratch);
  }

  clear(): void {
    this.home.clear();
    this.food.clear();
  }

  /** Both channels. Order is fixed; the shared scratch forbids parallel use. */
  update(): void {
    this.home.update();
    this.food.update();
  }
}
