/**
 * Every tuning knob in the simulation lives here.
 *
 * Behaviour work only ever touches this file — if a rule needs a new constant,
 * it belongs here, not inline in the hot loop.
 */

// ---------------------------------------------------------------------------
// World geometry
// ---------------------------------------------------------------------------

/** World is square, in world units. */
export const WORLD = 4096;

/** Obstacle map: 512² × 1 byte = 256 KB. Walls are intentionally thick. */
export const TERRAIN_SIZE = 512;
export const TERRAIN_CELL = WORLD / TERRAIN_SIZE; // 8 world units per cell

/**
 * Field and grid resolution scale with population.
 *
 * This is the honest way to hit the memory budget at every milestone instead of
 * paying for a 100K-sized field while running 100 ants. Resolution is part of
 * the world config, so (seed + resolution) fully determines the world.
 *
 *   population ≤ 2,000   → 256² pheromone (64 KB ×3), 64² grid
 *   population ≤ 20,000  → 512² pheromone (256 KB ×3), 128² grid
 *   above                → 1024² pheromone (1 MB ×3), 256² grid
 */
export interface Resolution {
  readonly pheroSize: number;
  readonly gridSize: number;
}

export function resolveResolution(population: number): Resolution {
  if (population <= 2_000) return { pheroSize: 256, gridSize: 64 };
  if (population <= 20_000) return { pheroSize: 512, gridSize: 128 };
  return { pheroSize: 1024, gridSize: 256 };
}

/** World units per pheromone cell for a given resolution. */
export function pheroCellWorld(pheroSize: number): number {
  return WORLD / pheroSize;
}

/** World units per neighbourhood-grid cell. */
export function gridCellWorld(gridSize: number): number {
  return WORLD / gridSize;
}

/** Hard population ceiling. Pools are allocated at the requested population. */
export const MAX_ANTS = 100_000;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Simulation rate. Decoupled from the 60 Hz render loop. */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/** Never run more than this many ticks in one frame (anti death-spiral). */
export const MAX_CATCHUP = 5;

/** Pheromone decay + diffusion runs every N ticks (4 Hz at 30 Hz sim). */
export const FIELD_UPDATE_EVERY = 8;

// ---------------------------------------------------------------------------
// Agent locomotion
// ---------------------------------------------------------------------------

/** Speed range in world units per tick, quantised into a Uint8. */
export const SPEED_MIN = 1.1;
export const SPEED_MAX = 2.8;

/** Forward probe distance for sensors and obstacle checks. */
export const PROBE = 7;
/** Sensor fan half-angle, radians. */
export const SENSOR_ANGLE = 0.62;
export const COS_SENSOR = Math.cos(SENSOR_ANGLE);
export const SIN_SENSOR = Math.sin(SENSOR_ANGLE);

/** Random wander amplitude per tick, radians. */
export const WANDER = 0.07;

/** Steering impulse toward a preferred pheromone sensor, radians. */
export const STEER_PHERO = 0.34;
/** Steering impulse to avoid an obstacle, radians. */
export const STEER_OBSTACLE = 0.95;

/** Pheromone reading below this is treated as "no signal". */
export const PHERO_THRESHOLD = 6;

/**
 * Neighbour separation. Radius is in world units; weight is a fraction of the
 * heading that gets bent away from crowded neighbours.
 *
 * MEASURED, not assumed: pairwise separation costs 9.3× throughput at 100,000
 * ants (0.68M → 6.37M updates/s when disabled). At that density the mean
 * nearest-neighbour spacing is ~13 world units against a 4.5-unit radius, so it
 * almost never fires and changes nothing you can see. It is therefore enabled
 * only below `SEPARATION_MAX_POP`, where it genuinely shapes the swarm.
 */
export const SEP_RADIUS = 4.5;
export const SEP_WEIGHT = 0.16;
export const SEPARATION_MAX_POP = 20_000;

/** How strongly a laden ant is pulled toward the nest (prevents deadlocks). */
export const HOMING_WEIGHT = 0.32;

/**
 * Energy below which a forager gives up and heads home.
 *
 * Without this a hungry ant simply wanders until it starves, and at 100,000
 * agents that was 56% of the colony dying every lifespan — half the population
 * churning in random directions at any moment, which is precisely why a
 * large colony looks like aimless roaming rather than work. Ants do path
 * integration and turn back when reserves run low; so do these.
 */
export const HUNGRY_ENERGY = 70;
/** Pull toward the nest once hungry. Gentler than a laden ant's, so it still forages on the way. */
export const HUNGRY_HOMING = 0.06;

// ---------------------------------------------------------------------------
// Pheromones
// ---------------------------------------------------------------------------

/**
 * Deposited per tick by a laden ant on the FOOD field.
 *
 * Tuned against the 8-bit field's saturation point: too high and the whole
 * trail pins at 255, the gradient dies, and the field renders as a white blob.
 */
export const DEPOSIT_FOOD = 10;
/**
 * Deposited by an outbound ant on the HOME field — but only while that ant is
 * actually standing on a FOOD trail.
 *
 * Leaving every forager depositing HOME everywhere fills the map with noise
 * (visually a blue wash, behaviourally a useless gradient). Gating on the trail
 * makes HOME mark exactly the corridor a laden ant wants: nest → food. Each
 * channel then reinforces the other instead of competing.
 */
export const DEPOSIT_HOME = 6;
/** Saturating ceiling to keep wraparound impossible. */
export const PHERO_MAX = 255;

/** Decay shift per field update: v -= v >> DECAY_SHIFT (≈1.6%). */
export const DECAY_SHIFT = 7;

// ---------------------------------------------------------------------------
// Colony & economy
// ---------------------------------------------------------------------------

export const NEST_RADIUS = 46;
/** Radius inside which an outbound ant ignores trails and heads outward. */
export const NEST_EXIT_RADIUS = 70;

/** Food picked up per visit. */
export const FOOD_LOAD = 1;

/** Ticks between energy decrements. Must be a power of two. */
export const ENERGY_DECAY_EVERY = 8;
/** Energy restored to a full ant at the nest. */
export const ENERGY_MAX = 255;

/** Number of seeded food sources. */
export const FOOD_SOURCES = 4;
export const FOOD_RADIUS_MIN = 70;
export const FOOD_RADIUS_MAX = 150;

/**
 * Food per ant in the colony.
 *
 * The larder has to scale with the colony or the demo dies: with a fixed
 * 20,000-unit budget a 100,000-ant colony strips every source bare in about
 * 70 seconds and then spends the rest of the session wandering with nothing to
 * do. Trip rate grows sublinearly with population, so a per-ant budget means a
 * bigger colony gets a longer runway rather than a shorter one.
 *
 * Measured at 100,000 agents: harvest settles at ~1,100 units/s once the trails
 * saturate, so 6 units/ant buys about 9 minutes before the colony runs dry.
 * Note the rate itself grows with the larder (more food, more successful trips),
 * which is why this does not scale linearly in the other direction.
 */
export const FOOD_PER_ANT = 6;

/**
 * Per-source share jitter, as a fraction of an even split. Sources should not
 * all hold exactly the same amount — the map should reward finding the rich one
 * — but no source may be so small that it is gone before a trail reaches it.
 */
export const FOOD_SHARE_MIN = 0.55;
export const FOOD_SHARE_MAX = 1.45;

/**
 * Food regrowth: each source gains `max(1, capacity / FOOD_REGROW_DIVISOR)`
 * units per tick, capped at its capacity.
 *
 * Without regrowth the world is a finite larder and the simulation has an
 * ending: measured at 100,000 agents, the colony strips 600,000 units bare in
 * about 9 minutes, after which 98% of ants wander with nothing to do. That is
 * not a colony foraging, it is a colony that has eaten everything — and it is
 * what a viewer sees if they leave the page open.
 *
 * The divisor sets the regrowth rate relative to a source's capacity, so the
 * ecology scales with colony size instead of needing retuning per population.
 * At 100,000 agents this returns ~2,160 units/s against ~1,400/s of harvest:
 * enough to keep the colony working indefinitely, not so much that every source
 * sits pinned at full and the trails go slack.
 */
export const FOOD_REGROW_DIVISOR = 8_000;

/** Food source ring around the nest, in world units. */
export const FOOD_DIST_MIN = 420;
export const FOOD_DIST_MAX = 1320;

// ---------------------------------------------------------------------------
// Steering / state codes
// ---------------------------------------------------------------------------

export const S_SEEKING = 0;
export const S_RETURNING = 1;
export const S_DEAD = 2;

export const F_ALIVE = 1;
export const F_CARRYING = 2;
