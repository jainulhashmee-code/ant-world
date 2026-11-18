/**
 * Structure-of-arrays agent pool.
 *
 * 28 bytes per ant. At 100,000 ants that is 2.8 MB — the single largest line
 * item in the 10 MB budget. No objects, no maps, no per-ant allocation ever.
 *
 * Heading is stored as a unit vector (dirX, dirY) rather than an angle. That
 * removes atan2 and sin/cos from the hot loop entirely: steering becomes a 2×2
 * rotation, and the renderer builds its rotation matrix straight from the
 * vector.
 */

import { mem } from '../core/memory';
import { nextU32, seedFor, U32_TO_F32 } from '../core/rng';
import { NEST_RADIUS, S_SEEKING, F_ALIVE, SPEED_MIN, SPEED_MAX } from '../core/config';
import type { World } from './world';

export class AgentPool {
  readonly capacity: number;
  count: number;

  /** World position. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Unit heading vector. */
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;

  /** 0..255 lifecycle energy; 0 triggers respawn. */
  readonly energy: Uint8Array;
  /** S_SEEKING | S_RETURNING | S_DEAD */
  readonly state: Uint8Array;
  /** Bit flags: F_ALIVE | F_CARRYING */
  readonly flags: Uint8Array;
  /** Carried food units. */
  readonly food: Uint8Array;
  /** Colony id (single colony until V3). */
  readonly colony: Uint8Array;
  /** Quantised speed, 0..255, mapped through the speed LUT. */
  readonly speed: Uint8Array;

  /** Ticks lived, saturating at 65535. */
  readonly age: Uint16Array;
  /** Per-agent xorshift32 state. Independent draws ⇒ parallel-safe. */
  readonly rng: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.count = 0;

    this.x = mem.f32('agents.x', capacity);
    this.y = mem.f32('agents.y', capacity);
    this.dirX = mem.f32('agents.dirX', capacity);
    this.dirY = mem.f32('agents.dirY', capacity);

    this.energy = mem.u8('agents.energy', capacity);
    this.state = mem.u8('agents.state', capacity);
    this.flags = mem.u8('agents.flags', capacity);
    this.food = mem.u8('agents.food', capacity);
    this.colony = mem.u8('agents.colony', capacity);
    this.speed = mem.u8('agents.speed', capacity);

    this.age = mem.u16('agents.age', capacity);
    this.rng = mem.u32('agents.rng', capacity);
  }

  /** Deterministically place ants in and around the nest. */
  spawn(world: World, count: number, worldSeed: number): void {
    const n = Math.min(count, this.capacity);
    this.count = n;
    const { nestX, nestY } = world;

    for (let i = 0; i < n; i++) {
      // Own the RNG stream for this ant: its spawn draws cannot be perturbed by
      // any other ant's existence.
      let rs = seedFor(i, worldSeed);

      rs = nextU32(rs);
      const a = rs * U32_TO_F32 * Math.PI * 2;
      rs = nextU32(rs);
      const r = (rs * U32_TO_F32) ** 0.5 * NEST_RADIUS * 0.85;

      // Opposite directions for the vector pair avoid a stack of trig calls.
      const c = Math.cos(a);
      const s = Math.sin(a);

      this.x[i] = nestX + c * r;
      this.y[i] = nestY + s * r;
      this.dirX[i] = c;
      this.dirY[i] = s;

      rs = nextU32(rs);
      const t = rs * U32_TO_F32;
      this.speed[i] = (t * 255) | 0;

      this.energy[i] = 200;
      this.state[i] = S_SEEKING;
      this.flags[i] = F_ALIVE;
      this.food[i] = 0;
      this.colony[i] = 0;
      this.age[i] = 0;
      this.rng[i] = rs === 0 ? 0x9e3779b9 : rs;
    }
    // Silence unused-import style: SPEED_MIN/MAX bound the LUT built by sim.
    void SPEED_MIN;
    void SPEED_MAX;
  }
}
