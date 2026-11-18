/**
 * Headless throughput benchmark.
 *
 *   npm run bench
 *   npm run bench -- --pop 100000 --ticks 300
 *
 * Deliberately measures what the browser cannot fake: agent updates per second
 * in the same JS engine, with the same code path.
 *
 * Method: build world → warm up (JIT) → timed runs → report median. Memory is
 * the exact sum of typed-array byteLength, captured immediately after
 * construction so it is not polluted by earlier runs.
 */

import { Simulation } from '../sim/simulation';
import { mem } from '../core/memory';

interface Args {
  pops: number[];
  ticks: number;
  warmup: number;
  runs: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { pops: [100, 1_000, 10_000], ticks: 300, warmup: 60, runs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--pop') {
      out.pops = v.split(',').map(Number);
      i++;
    } else if (a === '--ticks') {
      out.ticks = Number(v);
      i++;
    } else if (a === '--warmup') {
      out.warmup = Number(v);
      i++;
    } else if (a === '--runs') {
      out.runs = Number(v);
      i++;
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function benchPopulation(pop: number, args: Args): void {
  const before = mem.total();
  const sim = new Simulation({ seed: 42, population: pop });
  sim.world; // touch so nothing is treated as dead code
  const bytes = mem.total() - before;

  // Warm up: lets TurboFan optimise the hot loop before we time it.
  sim.run(args.warmup);

  const results: number[] = [];
  let lastStats = sim.stats();

  for (let r = 0; r < args.runs; r++) {
    const t0 = performance.now();
    sim.run(args.ticks);
    const dt = (performance.now() - t0) / 1000;
    results.push(args.ticks / dt);
    lastStats = sim.stats();
  }

  const tps = median(results);
  const ups = tps * pop;

  console.log(
    [
      String(pop).padStart(9),
      fmt(tps, 0).padStart(10),
      `${fmt(ups / 1e6, 2)}M`.padStart(10),
      `${(bytes / (1024 * 1024)).toFixed(2)} MB`.padStart(11),
      `${sim.resolution.pheroSize}²`.padStart(7),
      `${fmt(lastStats.deliveries).padStart(7)} trips`,
      fmt(lastStats.foodRemaining).padStart(9),
    ].join('  '),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('');
  console.log('ANT WORLD — headless simulation benchmark');
  console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`ticks=${args.ticks} warmup=${args.warmup} runs=${args.runs}`);
  console.log('');
  console.log(
    'population'.padStart(10) +
      '  ticks/s'.padStart(10) +
      '  updates/s'.padStart(10) +
      '   sim mem'.padStart(11) +
      '  field'.padStart(7) +
      '  trips'.padStart(12) +
      '   food left'.padStart(12),
  );
  console.log('-'.repeat(96));

  for (const pop of args.pops) benchPopulation(pop, args);

  console.log('-'.repeat(96));
  console.log('');
  console.log('Target: 3.00M updates/s sustained at 100,000 agents.');
  console.log('');
}

main();
