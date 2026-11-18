/**
 * The simulation.
 *
 * One fixed tick. Per ant, per tick:
 *   1. draw randomness from its own xorshift state
 *   2. read three pheromone sensors (left / centre / right)
 *   3. probe the terrain ahead
 *   4. accumulate steering: wander + pheromone + obstacle + separation
 *   5. rotate the unit heading, normalise, move
 *   6. deposit pheromone, then resolve state transitions
 *
 * No pathfinding, no map knowledge, no central planner. An ant knows three
 * pheromone numbers and a heading. Everything else is emergent.
 *
 * ── Why the code is split like this ─────────────────────────────────────────
 * The per-agent loop lives in `stepAgents()` and the neighbour scan lives in
 * `separateFrom()`. That is not stylistic: with the 3×3 neighbour loop inline,
 * V8 repeatedly deoptimised `step()` with "exit from OSR'd inner loop" and
 * re-optimised it every few ticks, costing roughly 10× throughput. Nested loops
 * that OSR inside a large hot loop are a performance cliff; splitting them out
 * keeps the hot loop compiled once, for good. Measured, not assumed — see
 * BENCHMARKS.md.
 */

import { mem } from '../core/memory';
import { fnv1a, nextU32, U32_TO_F32 } from '../core/rng';
import {
  WORLD,
  SPEED_MIN,
  SPEED_MAX,
  PROBE,
  COS_SENSOR,
  SIN_SENSOR,
  WANDER,
  STEER_PHERO,
  STEER_OBSTACLE,
  PHERO_THRESHOLD,
  HOMING_WEIGHT,
  SEP_RADIUS,
  SEP_WEIGHT,
  SEPARATION_MAX_POP,
  DEPOSIT_FOOD,
  DEPOSIT_HOME,
  NEST_RADIUS,
  NEST_EXIT_RADIUS,
  FOOD_LOAD,
  ENERGY_MAX,
  ENERGY_DECAY_EVERY,
  FIELD_UPDATE_EVERY,
  S_SEEKING,
  S_RETURNING,
  F_ALIVE,
  F_CARRYING,
  resolveResolution,
} from '../core/config';
import type { Resolution } from '../core/config';
import { AgentPool } from './agents';
import { World } from './world';
import { PheromoneSet } from './pheromones';
import { SpatialGrid } from './spatial';
import type { PheromoneField } from './pheromones';

const TAU = Math.PI * 2;
const SEP_R2 = SEP_RADIUS * SEP_RADIUS;

export interface SimOptions {
  seed: number;
  population: number;
  /**
   * Override the automatic separation LOD. Normally left undefined so the
   * population-based rule below decides; only benchmarks A/B this.
   */
  separation?: boolean;
}

export interface SimStats {
  tick: number;
  population: number;
  delivered: number;
  deliveries: number;
  revivals: number;
  seeking: number;
  returning: number;
  foodRemaining: number;
  pheroHome: number;
  pheroFood: number;
  memMB: number;
}

export class Simulation {
  readonly seed: number;
  readonly resolution: Resolution;
  readonly world: World;
  readonly agents: AgentPool;
  readonly fields: PheromoneSet;
  readonly grid: SpatialGrid;

  tick = 0;

  /** Lifetime telemetry. */
  delivered = 0;
  deliveries = 0;
  revivals = 0;

  /** Speed LUT: quantised Uint8 → world units per tick. */
  private readonly speeds: Float32Array;
  private readonly separation: boolean;

  /** Scratch for `separateFrom` — avoids returning a tuple (which allocates). */
  private sepX = 0;
  private sepY = 0;

  constructor(opts: SimOptions) {
    this.seed = opts.seed >>> 0;
    // Density-aware LOD: see SEPARATION_MAX_POP for the measurement behind it.
    this.separation = opts.separation ?? opts.population <= SEPARATION_MAX_POP;
    this.resolution = resolveResolution(opts.population);

    this.world = new World();
    this.world.generate(this.seed, opts.population);

    this.agents = new AgentPool(opts.population);
    this.agents.spawn(this.world, opts.population, this.seed);

    this.fields = new PheromoneSet(this.resolution.pheroSize, WORLD);
    this.grid = new SpatialGrid(this.resolution.gridSize, opts.population);

    this.speeds = mem.f32('agents.speedLut', 256);
    for (let i = 0; i < 256; i++) {
      this.speeds[i] = SPEED_MIN + (i / 255) * (SPEED_MAX - SPEED_MIN);
    }
  }

  /** Advance exactly one tick. Allocation-free. */
  step(): void {
    this.grid.build(this.agents, this.agents.count);
    this.stepAgents();

    // Field maintenance runs at a slower cadence than movement: nobody can see
    // a pheromone field update at 60 Hz, and it is the second-largest cost.
    if ((this.tick & (FIELD_UPDATE_EVERY - 1)) === 0) this.fields.update();

    this.tick++;
  }

  /**
   * The hot loop. Every value it touches is a typed array element or a local;
   * a `new` in here would surface as GC sawtooth in the soak test.
   */
  private stepAgents(): void {
    const A = this.agents;
    const n = A.count;

    const X = A.x;
    const Y = A.y;
    const DX = A.dirX;
    const DY = A.dirY;
    const E = A.energy;
    const ST = A.state;
    const FL = A.flags;
    const FD = A.food;
    const AG = A.age;
    const SPD = A.speed;
    const R = A.rng;

    const W = this.world;
    const FX = W.foodX;
    const FY = W.foodY;
    const FR2 = W.foodR2;
    const FAM = W.foodAmount;
    const foodCount = W.foodCount;
    const nestX = W.nestX;
    const nestY = W.nestY;

    const fields = this.fields;
    const home = fields.home;
    const food = fields.food;

    const SPEEDS = this.speeds;
    const nestR2 = NEST_RADIUS * NEST_RADIUS;
    const exitR2 = NEST_EXIT_RADIUS * NEST_EXIT_RADIUS;
    const doSeparation = this.separation;
    const energyTick = (this.tick & (ENERGY_DECAY_EVERY - 1)) === 0;

    let delivered = this.delivered;
    let deliveries = this.deliveries;
    let revivals = this.revivals;

    for (let i = 0; i < n; i++) {
      let x = X[i];
      let y = Y[i];
      let dx = DX[i];
      let dy = DY[i];
      let st = ST[i];

      // ---- randomness: one draw per ant per tick -------------------------
      let rs = R[i];
      rs ^= rs << 13;
      rs >>>= 0;
      rs ^= rs >>> 17;
      rs ^= rs << 5;
      rs >>>= 0;
      const rnd = rs * U32_TO_F32;

      // ---- sensor directions: heading rotated by ±SENSOR_ANGLE -----------
      const lx = dx * COS_SENSOR - dy * SIN_SENSOR;
      const ly = dx * SIN_SENSOR + dy * COS_SENSOR;
      const rx = dx * COS_SENSOR + dy * SIN_SENSOR;
      const ry = -dx * SIN_SENSOR + dy * COS_SENSOR;

      const ax = x + dx * PROBE;
      const ay = y + dy * PROBE;

      let steer = (rnd - 0.5) * WANDER;

      // ---- obstacle avoidance -------------------------------------------
      if (W.isWall(ax, ay)) {
        const openL = !W.isWall(x + lx * PROBE, y + ly * PROBE);
        const openR = !W.isWall(x + rx * PROBE, y + ry * PROBE);
        if (openL !== openR) steer += openL ? STEER_OBSTACLE : -STEER_OBSTACLE;
        else steer += rnd > 0.5 ? STEER_OBSTACLE : -STEER_OBSTACLE;
      }

      const ndx = x - nestX;
      const ndy = y - nestY;
      const distNest2 = ndx * ndx + ndy * ndy;

      // ---- pheromone steering (blind inside the nest apron) --------------
      // Outbound ants follow FOOD; laden ants follow HOME. This is the entire
      // communication system: one scalar field, three taps, one comparison.
      let onTrail = false;
      if (distNest2 > exitR2) {
        const field: PheromoneField = st === S_RETURNING ? home : food;
        const cL = field.sampleWorld(x + lx * PROBE, y + ly * PROBE);
        const cC = field.sampleWorld(ax, ay);
        const cR = field.sampleWorld(x + rx * PROBE, y + ry * PROBE);
        if (cL > cC && cL > cR) {
          if (cL > PHERO_THRESHOLD) steer += STEER_PHERO;
        } else if (cR > cC && cR > cL) {
          if (cR > PHERO_THRESHOLD) steer -= STEER_PHERO;
        }
        onTrail = cC > PHERO_THRESHOLD;
      }

      // ---- homing pull for laden ants ------------------------------------
      // A small bias, not a path: it stops a laden ant orbiting a phero-free
      // pocket forever while leaving trail-following dominant.
      if (st === S_RETURNING) {
        const d = Math.sqrt(distNest2) + 1e-6;
        const k = HOMING_WEIGHT;
        dx = dx * (1 - k) - (ndx / d) * k;
        dy = dy * (1 - k) - (ndy / d) * k;
      }

      // ---- separation from neighbours ------------------------------------
      if (doSeparation) {
        this.separateFrom(i, x, y);
        if (this.sepX !== 0 || this.sepY !== 0) {
          dx += this.sepX * SEP_WEIGHT;
          dy += this.sepY * SEP_WEIGHT;
        }
      }

      // ---- apply steering as a 2×2 rotation, then normalise ---------------
      // Small-angle approximations are exact enough here: |steer| is bounded by
      // the constants above and never exceeds ~0.5 rad.
      const cs = 1 - steer * steer * 0.5;
      const sn = steer;
      const nx = dx * cs - dy * sn;
      const ny = dx * sn + dy * cs;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1e-12);
      dx = nx * inv;
      dy = ny * inv;

      // ---- move -----------------------------------------------------------
      const sp = SPEEDS[SPD[i]];
      x += dx * sp;
      y += dy * sp;

      if (x < 0) {
        x = 0;
        dx = -dx;
      } else if (x > WORLD) {
        x = WORLD;
        dx = -dx;
      }
      if (y < 0) {
        y = 0;
        dy = -dy;
      } else if (y > WORLD) {
        y = WORLD;
        dy = -dy;
      }

      // ---- deposit --------------------------------------------------------
      // FOOD marks the way out; HOME marks the corridor only where it is
      // productive. Two channels reinforcing each other, not competing.
      if (st === S_RETURNING) food.depositWorld(x, y, DEPOSIT_FOOD);
      else if (onTrail) home.depositWorld(x, y, DEPOSIT_HOME);

      // ---- transitions ----------------------------------------------------
      if (st === S_SEEKING) {
        for (let f = 0; f < foodCount; f++) {
          if (FAM[f] <= 0) continue;
          const ddx = x - FX[f];
          const ddy = y - FY[f];
          if (ddx * ddx + ddy * ddy <= FR2[f]) {
            FAM[f] -= FOOD_LOAD;
            st = S_RETURNING;
            FD[i] = FOOD_LOAD;
            FL[i] = F_ALIVE | F_CARRYING;
            // A forager that reached food has, by definition, eaten. Without
            // this the energy budget only refills on *delivery*, so any ant
            // whose round trip is longer than its lifespan starves en route and
            // drops the load it was carrying. At 100,000 agents that was the
            // majority of the colony: 90,000 revivals in 20 seconds, with two
            // thirds of all harvested food destroyed in transit. Energy then
            // means what it should — a lost ant dies, a productive one persists.
            E[i] = ENERGY_MAX;
            break;
          }
        }
      } else if (st === S_RETURNING) {
        const rdx = x - nestX;
        const rdy = y - nestY;
        const r2 = rdx * rdx + rdy * rdy;
        if (r2 <= nestR2) {
          delivered += FD[i];
          deliveries++;
          FD[i] = 0;
          FL[i] = F_ALIVE;
          E[i] = ENERGY_MAX;
          st = S_SEEKING;
          // Turn outward so the ant leaves instead of milling in the entrance.
          if (r2 > 1e-6) {
            const ri = 1 / Math.sqrt(r2);
            dx = rdx * ri;
            dy = rdy * ri;
          }
        }
      }

      // ---- energy & lifecycle ---------------------------------------------
      if (energyTick) {
        const e = E[i];
        if (e > 1) {
          E[i] = e - 1;
        } else {
          // Starved. Respawn at the nest rather than shrinking the pool, so the
          // population — and therefore the frame cost — stays constant.
          revivals++;
          rs = nextU32(rs);
          const a = rs * U32_TO_F32 * TAU;
          const c2 = Math.cos(a);
          const s2 = Math.sin(a);
          const rr = (rs & 1023) * 0.03;
          x = nestX + c2 * rr;
          y = nestY + s2 * rr;
          dx = c2;
          dy = s2;
          E[i] = ENERGY_MAX;
          FD[i] = 0;
          FL[i] = F_ALIVE;
          st = S_SEEKING;
        }
        const a2 = AG[i];
        if (a2 < 65535) AG[i] = a2 + 1;
      }

      // ---- write back ------------------------------------------------------
      R[i] = rs;
      X[i] = x;
      Y[i] = y;
      DX[i] = dx;
      DY[i] = dy;
      ST[i] = st;
    }

    this.delivered = delivered;
    this.deliveries = deliveries;
    this.revivals = revivals;
  }

  /**
   * Sum a repulsion unit-vector away from neighbours.
   *
   * Kept out of the hot loop on purpose: a nested loop there makes V8 discard
   * its optimised code every tick (see the file header).
   */
  private separateFrom(i: number, x: number, y: number): void {
    const grid = this.grid;
    const heads = grid.heads;
    const nxt = grid.next;
    const gSize = grid.size;
    const gLast = gSize - 1;
    const X = this.agents.x;
    const Y = this.agents.y;

    const c = grid.cellOf[i];
    const cxg = c % gSize;
    const cyg = (c / gSize) | 0;
    const gx0 = cxg > 0 ? cxg - 1 : 0;
    const gx1 = cxg < gLast ? cxg + 1 : gLast;
    const gy0 = cyg > 0 ? cyg - 1 : 0;
    const gy1 = cyg < gLast ? cyg + 1 : gLast;

    let px = 0;
    let py = 0;

    for (let gy = gy0; gy <= gy1; gy++) {
      const row = gy * gSize;
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let j = heads[row + gx]; j !== -1; j = nxt[j]) {
          if (j === i) continue;
          const ddx = x - X[j];
          const ddy = y - Y[j];
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < SEP_R2 && d2 > 1e-6) {
            const inv = 1 / Math.sqrt(d2);
            px += ddx * inv;
            py += ddy * inv;
          }
        }
      }
    }

    if (px !== 0 || py !== 0) {
      const pl = 1 / Math.sqrt(px * px + py * py + 1e-12);
      this.sepX = px * pl;
      this.sepY = py * pl;
    } else {
      this.sepX = 0;
      this.sepY = 0;
    }
  }

  /** Run `ticks` steps. Convenience for tests and benchmarks. */
  run(ticks: number): void {
    for (let t = 0; t < ticks; t++) this.step();
  }

  /** Telemetry for the HUD. Allocates one small object — call at HUD rate only. */
  stats(): SimStats {
    const A = this.agents;
    let seeking = 0;
    let returning = 0;
    for (let i = 0; i < A.count; i++) {
      if (A.state[i] === S_RETURNING) returning++;
      else seeking++;
    }
    const home = this.fields.home.data;
    const food = this.fields.food.data;
    let sh = 0;
    let sf = 0;
    for (let i = 0; i < home.length; i++) {
      sh += home[i];
      sf += food[i];
    }
    const cells = home.length || 1;

    return {
      tick: this.tick,
      population: A.count,
      delivered: this.delivered,
      deliveries: this.deliveries,
      revivals: this.revivals,
      seeking,
      returning,
      foodRemaining: this.world.remainingFood(),
      pheroHome: sh / cells,
      pheroFood: sf / cells,
      memMB: mem.totalMB(),
    };
  }

  /**
   * FNV-1a over the observable state.
   *
   * Determinism contract: same seed + same tick count ⇒ same hash. Floats are
   * hashed through their byte view so no precision is lost in the check.
   */
  hash(): number {
    const A = this.agents;
    let h = 0x811c9dc5;
    h = fnv1a(new Uint8Array(A.x.buffer, A.x.byteOffset, A.x.byteLength), h);
    h = fnv1a(new Uint8Array(A.y.buffer, A.y.byteOffset, A.y.byteLength), h);
    h = fnv1a(new Uint8Array(A.dirX.buffer, A.dirX.byteOffset, A.dirX.byteLength), h);
    h = fnv1a(new Uint8Array(A.state.buffer, A.state.byteOffset, A.state.byteLength), h);
    h = fnv1a(new Uint8Array(A.energy.buffer, A.energy.byteOffset, A.energy.byteLength), h);
    return h >>> 0;
  }
}
