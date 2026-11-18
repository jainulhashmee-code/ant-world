import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { World } from '../src/sim/world';
import { PheromoneField, PheromoneSet } from '../src/sim/pheromones';
import { SpatialGrid } from '../src/sim/spatial';
import { AgentPool } from '../src/sim/agents';
import { S_RETURNING, WORLD } from '../src/core/config';

describe('determinism', () => {
  it('replays bit-identically from the same seed', () => {
    const a = new Simulation({ seed: 42, population: 100 });
    const b = new Simulation({ seed: 42, population: 100 });

    expect(a.hash()).toBe(b.hash());

    a.run(300);
    b.run(300);
    expect(a.hash()).toBe(b.hash());

    a.run(2_700);
    b.run(2_700);
    expect(a.hash()).toBe(b.hash());
    expect(a.tick).toBe(3_000);
  });

  it('diverges when the seed changes', () => {
    const a = new Simulation({ seed: 1, population: 100 });
    const b = new Simulation({ seed: 2, population: 100 });
    a.run(200);
    b.run(200);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('does not depend on population neighbours', () => {
    // Agents own their RNG state, so agent 0's draws must be identical whether
    // the world holds 100 ants or 1,000. This is the property that makes
    // domain-decomposed multi-worker simulation possible later.
    const small = new Simulation({ seed: 7, population: 100 });
    const large = new Simulation({ seed: 7, population: 1_000 });
    small.run(50);
    large.run(50);
    expect(small.agents.rng[0]).toBe(large.agents.rng[0]);
  });
});

describe('foraging loop', () => {
  it('completes deliveries and consumes food', () => {
    const sim = new Simulation({ seed: 42, population: 200 });
    sim.run(3_000);

    expect(sim.deliveries).toBeGreaterThan(0);
    expect(sim.delivered).toBeGreaterThan(0);
    expect(sim.world.remainingFood()).toBeLessThan(
      sim.world.foodMax.reduce((acc: number, v: number) => acc + v, 0) as number,
    );
  });

  it('keeps every ant inside the world', () => {
    const sim = new Simulation({ seed: 3, population: 300 });
    sim.run(1_500);
    const { x, y, count } = sim.agents;
    for (let i = 0; i < count; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(y[i]).toBeGreaterThanOrEqual(0);
      expect(x[i]).toBeLessThanOrEqual(WORLD + 1e-3);
      expect(y[i]).toBeLessThanOrEqual(WORLD + 1e-3);
    }
  });

  it('keeps headings normalised to unit length', () => {
    const sim = new Simulation({ seed: 5, population: 200 });
    sim.run(600);
    const { dirX, dirY, count } = sim.agents;
    for (let i = 0; i < count; i++) {
      const len = Math.hypot(dirX[i], dirY[i]);
      expect(len).toBeCloseTo(1, 3);
    }
  });

  it('carries food only while returning', () => {
    const sim = new Simulation({ seed: 11, population: 300 });
    sim.run(2_000);
    const { state, food, count } = sim.agents;
    for (let i = 0; i < count; i++) {
      if (food[i] > 0) expect(state[i]).toBe(S_RETURNING);
    }
  });
});

describe('world generation', () => {
  it('never buries a food source in rock', () => {
    for (const seed of [1, 42, 99, 12_345]) {
      const w = new World();
      w.generate(seed);
      expect(w.foodCount).toBeGreaterThan(0);
      for (let i = 0; i < w.foodCount; i++) {
        expect(w.isWall(w.foodX[i], w.foodY[i])).toBe(false);
        expect(w.foodAmount[i]).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the nest walkable', () => {
    for (const seed of [1, 42, 99]) {
      const w = new World();
      w.generate(seed);
      expect(w.isWall(w.nestX, w.nestY)).toBe(false);
    }
  });

  it('is reproducible from the seed', () => {
    const a = new World();
    const b = new World();
    a.generate(7);
    b.generate(7);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(a.foodCount).toBe(b.foodCount);
  });

  it('scales the larder with the colony', () => {
    // Regression guard: a fixed food budget starves a 100K colony in about a
    // minute, after which every ant wanders with nothing to do. The larder has
    // to grow with the population for the forage loop to stay meaningful.
    const perAnt = (population: number): number => {
      const w = new World();
      w.generate(42, population);
      let total = 0;
      for (let i = 0; i < w.foodCount; i++) total += w.foodAmount[i];
      return total / population;
    };

    const small = perAnt(1_000);
    const large = perAnt(100_000);
    expect(small).toBeGreaterThan(1);
    expect(large).toBeGreaterThan(1);
    // Same per-ant budget at both ends of the range (jitter is seeded per
    // population only through the share draw, so allow the source-count spread).
    expect(large / small).toBeGreaterThan(0.7);
    expect(large / small).toBeLessThan(1.4);
  });
});

describe('pheromones', () => {
  const make = (size = 64) => {
    const set = new PheromoneSet(size, WORLD);
    return set;
  };

  it('saturates instead of wrapping', () => {
    const set = make();
    const f = set.home;
    for (let i = 0; i < 100; i++) f.depositWorld(200, 200, 40);
    const v = f.sampleWorld(200, 200);
    expect(v).toBeLessThanOrEqual(255);
    expect(v).toBeGreaterThan(0);
  });

  it('decays toward zero', () => {
    const set = make();
    set.home.depositWorld(1000, 1000, 255);
    const before = set.home.sampleWorld(1000, 1000);
    for (let i = 0; i < 400; i++) set.home.update();
    const after = set.home.sampleWorld(1000, 1000);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(2);
  });

  it('conserves mass roughly under diffusion', () => {
    const set = make();
    set.food.depositWorld(2000, 2000, 200);
    const d = set.food.data;
    let sumBefore = 0;
    for (let i = 0; i < d.length; i++) sumBefore += d[i];
    set.food.update();
    let sumAfter = 0;
    for (let i = 0; i < d.length; i++) sumAfter += d[i];
    // Diffusion spreads, decay removes a little — never gains.
    expect(sumAfter).toBeLessThanOrEqual(sumBefore);
    expect(sumAfter).toBeGreaterThan(sumBefore * 0.9);
  });

  it('reads zero far outside the world', () => {
    const f = new PheromoneField('t', 32, WORLD, new Uint8Array(32 * 32));
    expect(f.sampleWorld(-500, -500)).toBe(0);
    expect(f.sampleWorld(WORLD + 500, WORLD + 500)).toBe(0);
  });
});

describe('spatial grid', () => {
  it('indexes every agent exactly once', () => {
    const pool = new AgentPool(500);
    const world = new World();
    world.generate(42);
    pool.spawn(world, 500, 42);

    const grid = new SpatialGrid(64, 500);
    grid.build(pool, 500);

    const seen = new Set<number>();
    for (let c = 0; c < grid.heads.length; c++) {
      for (let j = grid.heads[c]; j !== -1; j = grid.next[j]) {
        expect(seen.has(j)).toBe(false);
        seen.add(j);
      }
    }
    expect(seen.size).toBe(500);
  });
});
