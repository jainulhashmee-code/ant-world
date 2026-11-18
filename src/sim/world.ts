/**
 * World: static geometry, the nest, and food sources.
 *
 * Everything is generated from the world seed, so `?seed=42` reproduces the
 * same map, the same ant placements and therefore the same simulation.
 */

import { mem } from '../core/memory';
import { splitmix32, U32_TO_F32 } from '../core/rng';
import {
  WORLD,
  TERRAIN_SIZE,
  TERRAIN_CELL,
  NEST_RADIUS,
  FOOD_SOURCES,
  FOOD_RADIUS_MIN,
  FOOD_RADIUS_MAX,
  FOOD_AMOUNT_MIN,
  FOOD_AMOUNT_MAX,
  FOOD_DIST_MIN,
  FOOD_DIST_MAX,
} from '../core/config';

const INV_TERRAIN_CELL = 1 / TERRAIN_CELL;

/** Max food sources the SoA can hold. */
const MAX_SOURCES = 32;
/** Max obstacle circles retained for rendering (clusters × satellites). */
const MAX_ROCKS = 256;

export class World {
  readonly size = WORLD;

  /** 0 = walkable, 1 = wall. */
  readonly terrain: Uint8Array;

  /** Nest centre and radius. */
  nestX = WORLD * 0.5;
  nestY = WORLD * 0.5;
  readonly nestRadius = NEST_RADIUS;

  /** Obstacle circles, retained only so the renderer can draw them. */
  readonly rockX: Float32Array;
  readonly rockY: Float32Array;
  readonly rockR: Float32Array;
  rockCount = 0;

  /** Food sources as a struct-of-arrays. */
  readonly foodX: Float32Array;
  readonly foodY: Float32Array;
  readonly foodR: Float32Array;
  readonly foodR2: Float32Array;
  readonly foodAmount: Int32Array;
  readonly foodMax: Int32Array;
  foodCount = 0;

  constructor() {
    this.terrain = mem.u8('world.terrain', TERRAIN_SIZE * TERRAIN_SIZE);
    this.rockX = mem.f32('world.rockX', MAX_ROCKS);
    this.rockY = mem.f32('world.rockY', MAX_ROCKS);
    this.rockR = mem.f32('world.rockR', MAX_ROCKS);
    this.foodX = mem.f32('world.foodX', MAX_SOURCES);
    this.foodY = mem.f32('world.foodY', MAX_SOURCES);
    this.foodR = mem.f32('world.foodR', MAX_SOURCES);
    this.foodR2 = mem.f32('world.foodR2', MAX_SOURCES);
    this.foodAmount = mem.i32('world.foodAmount', MAX_SOURCES);
    this.foodMax = mem.i32('world.foodMax', MAX_SOURCES);
  }

  /** Deterministic map generation. */
  generate(worldSeed: number): void {
    this.terrain.fill(0);
    this.foodCount = 0;
    this.rockCount = 0;

    let s = worldSeed | 0;

    // ---- obstacles: organic rock clusters --------------------------------
    const rockCount = 22;
    for (let k = 0; k < rockCount; k++) {
      s = splitmix32(s);
      const cx = (s * U32_TO_F32) * WORLD;
      s = splitmix32(s);
      const cy = (s * U32_TO_F32) * WORLD;
      s = splitmix32(s);
      const baseR = 26 + (s * U32_TO_F32) * 120;

      // Never wall off the nest.
      const dn = Math.hypot(cx - this.nestX, cy - this.nestY);
      if (dn < baseR + 190) continue;

      this.rasterRock(cx, cy, baseR, s);
      this.pushRock(cx, cy, baseR);

      // Satellites make the cluster look geological rather than stamped.
      for (let j = 0; j < 3; j++) {
        s = splitmix32(s);
        const ang = (s * U32_TO_F32) * Math.PI * 2;
        s = splitmix32(s);
        const off = baseR * (0.55 + (s * U32_TO_F32) * 0.6);
        s = splitmix32(s);
        const r = baseR * (0.3 + (s * U32_TO_F32) * 0.4);
        const sx = cx + Math.cos(ang) * off;
        const sy = cy + Math.sin(ang) * off;
        this.rasterRock(sx, sy, r, s);
        this.pushRock(sx, sy, r);
      }
    }

    // ---- food sources: spread around the nest ---------------------------
    for (let f = 0; f < FOOD_SOURCES; f++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        s = splitmix32(s);
        const ang = (f / FOOD_SOURCES) * Math.PI * 2 + (s * U32_TO_F32) * 0.9;
        s = splitmix32(s);
        const dist = FOOD_DIST_MIN + (s * U32_TO_F32) * (FOOD_DIST_MAX - FOOD_DIST_MIN);
        s = splitmix32(s);
        const r = FOOD_RADIUS_MIN + (s * U32_TO_F32) * (FOOD_RADIUS_MAX - FOOD_RADIUS_MIN);

        const fx = this.nestX + Math.cos(ang) * dist;
        const fy = this.nestY + Math.sin(ang) * dist;

        // Keep sources on the map and out of the rocks (checked at the centre
        // and on the rim, so a source cannot be half-buried).
        if (fx < r + 40 || fy < r + 40 || fx > WORLD - r - 40 || fy > WORLD - r - 40) continue;
        if (this.circleTouchesWall(fx, fy, r)) continue;

        s = splitmix32(s);
        const amount =
          FOOD_AMOUNT_MIN + ((s * U32_TO_F32) * (FOOD_AMOUNT_MAX - FOOD_AMOUNT_MIN)) | 0;

        const i = this.foodCount++;
        this.foodX[i] = fx;
        this.foodY[i] = fy;
        this.foodR[i] = r;
        this.foodR2[i] = r * r;
        this.foodAmount[i] = amount;
        this.foodMax[i] = amount;
        break;
      }
    }
  }

  private pushRock(cx: number, cy: number, r: number): void {
    if (this.rockCount >= MAX_ROCKS) return;
    const i = this.rockCount++;
    this.rockX[i] = cx;
    this.rockY[i] = cy;
    this.rockR[i] = r;
  }

  private rasterRock(cx: number, cy: number, r: number, seed: number): void {
    const t = this.terrain;
    const cellR = r * INV_TERRAIN_CELL;
    const c0x = Math.max(0, Math.floor((cx - r) * INV_TERRAIN_CELL));
    const c1x = Math.min(TERRAIN_SIZE - 1, Math.ceil((cx + r) * INV_TERRAIN_CELL));
    const c0y = Math.max(0, Math.floor((cy - r) * INV_TERRAIN_CELL));
    const c1y = Math.min(TERRAIN_SIZE - 1, Math.ceil((cy + r) * INV_TERRAIN_CELL));
    const r2 = r * r;
    let s = seed;

    for (let gy = c0y; gy <= c1y; gy++) {
      const wy = (gy + 0.5) * TERRAIN_CELL;
      const dy = wy - cy;
      for (let gx = c0x; gx <= c1x; gx++) {
        const wx = (gx + 0.5) * TERRAIN_CELL;
        const dx = wx - cx;
        // Cheap per-cell jitter breaks the perfect circle without a noise field.
        s = splitmix32(s);
        const wobble = 1 + ((s & 63) - 32) * 0.006;
        if (dx * dx + dy * dy <= r2 * wobble) t[gy * TERRAIN_SIZE + gx] = 1;
      }
    }
    void cellR;
  }

  private circleTouchesWall(cx: number, cy: number, r: number): boolean {
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      if (this.isWall(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8)) return true;
    }
    return this.isWall(cx, cy);
  }

  /** Terrain probe. Out of bounds counts as wall. */
  isWall(x: number, y: number): boolean {
    const gx = (x * INV_TERRAIN_CELL) | 0;
    const gy = (y * INV_TERRAIN_CELL) | 0;
    if (gx < 0 || gy < 0 || gx >= TERRAIN_SIZE || gy >= TERRAIN_SIZE) return true;
    return this.terrain[gy * TERRAIN_SIZE + gx] !== 0;
  }

  /** Total food remaining across all sources. */
  remainingFood(): number {
    let sum = 0;
    for (let i = 0; i < this.foodCount; i++) sum += this.foodAmount[i];
    return sum;
  }
}
