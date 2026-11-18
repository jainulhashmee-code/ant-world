/**
 * CPU profiler harness.
 *
 *   node --cpu-prof --cpu-prof-dir=.prof --import tsx src/bench/profile.ts
 *
 * Then summarise with `node scripts/cpu-report.mjs`. Guessing at hot spots is
 * how you optimise the wrong loop; this exists so we never do that.
 */

import { Simulation } from '../sim/simulation';

const pop = Number(process.argv[2] ?? 10_000);
const ticks = Number(process.argv[3] ?? 120);

const sim = new Simulation({ seed: 42, population: pop });

// Warm up so the profile shows optimised code, not interpreter warmup.
sim.run(60);

const t0 = performance.now();
sim.run(ticks);
const ms = performance.now() - t0;

console.error(
  `pop=${pop} ticks=${ticks} ${ms.toFixed(1)}ms  ${(ticks / (ms / 1000)).toFixed(0)} ticks/s  ` +
    `${(((ticks * pop) / (ms / 1000)) / 1e6).toFixed(2)}M updates/s`,
);
