/**
 * Instance buffers, built once per frame from the simulation's typed arrays.
 *
 * This is the only place simulation data touches a GPU-bound buffer, and it
 * writes straight into a preallocated ArrayBuffer — no intermediate arrays, no
 * `map`, no allocation per frame.
 */

import {
  INSTANCE_SLOTS,
  INSTANCE_BYTES,
  COLOR_FOOD,
  COLOR_NEST,
  COLOR_RETURNING,
  COLOR_ROCK,
  COLOR_SEEKING,
  rgba,
} from './layout';
import type { AgentPool } from '../sim/agents';
import type { World } from '../sim/world';
import { S_RETURNING } from '../core/config';

/** Low-energy ants fade toward this. */
const COLOR_TIRED = rgba(120, 96, 66);

export class InstanceBuffer {
  readonly ab: ArrayBuffer;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ab = new ArrayBuffer(capacity * INSTANCE_BYTES);
    this.f32 = new Float32Array(this.ab);
    this.u32 = new Uint32Array(this.ab);
  }

  /** Bytes to upload for `count` instances. */
  byteLength(count: number): number {
    return count * INSTANCE_BYTES;
  }

  /**
   * Fill from the agent pool. Colour encodes state and energy, which is the
   * cheapest way to make colony activity legible without a second pass.
   */
  writeAnts(pool: AgentPool, count: number): number {
    const X = pool.x;
    const Y = pool.y;
    const DX = pool.dirX;
    const DY = pool.dirY;
    const ST = pool.state;
    const E = pool.energy;
    const f = this.f32;
    const u = this.u32;
    const n = count < this.capacity ? count : this.capacity;

    for (let i = 0; i < n; i++) {
      const o = i * INSTANCE_SLOTS;
      f[o] = X[i];
      f[o + 1] = Y[i];
      f[o + 2] = DX[i];
      f[o + 3] = DY[i];

      let c = ST[i] === S_RETURNING ? COLOR_RETURNING : COLOR_SEEKING;
      const e = E[i];
      if (e < 90) {
        // Blend toward the tired colour as energy runs out.
        const t = e / 90;
        const r = ((c & 255) * t + (COLOR_TIRED & 255) * (1 - t)) | 0;
        const g = (((c >> 8) & 255) * t + ((COLOR_TIRED >> 8) & 255) * (1 - t)) | 0;
        const b = (((c >> 16) & 255) * t + ((COLOR_TIRED >> 16) & 255) * (1 - t)) | 0;
        c = rgba(r, g, b);
      }
      u[o + 4] = c;
      f[o + 5] = 1; // size multiplier; uniform antSize scales it
    }
    return n;
  }

  /**
   * Nest, food sources and obstacle circles. Static per world, but cheap enough
   * (~100 instances) to rebuild whenever the world changes.
   */
  writeMarkers(world: World): number {
    const f = this.f32;
    const u = this.u32;
    let i = 0;

    for (let r = 0; r < world.rockCount && i < this.capacity; r++, i++) {
      const o = i * INSTANCE_SLOTS;
      f[o] = world.rockX[r];
      f[o + 1] = world.rockY[r];
      f[o + 2] = 1;
      f[o + 3] = 0;
      u[o + 4] = COLOR_ROCK;
      f[o + 5] = world.rockR[r];
    }

    for (let s = 0; s < world.foodCount && i < this.capacity; s++, i++) {
      const o = i * INSTANCE_SLOTS;
      f[o] = world.foodX[s];
      f[o + 1] = world.foodY[s];
      f[o + 2] = 1;
      f[o + 3] = 0;
      u[o + 4] = COLOR_FOOD;
      f[o + 5] = world.foodR[s];
    }

    if (i < this.capacity) {
      const o = i * INSTANCE_SLOTS;
      f[o] = world.nestX;
      f[o + 1] = world.nestY;
      f[o + 2] = 1;
      f[o + 3] = 0;
      u[o + 4] = COLOR_NEST;
      f[o + 5] = world.nestRadius;
      i++;
    }

    return i;
  }
}
