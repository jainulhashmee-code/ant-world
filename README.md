# Ant World

**A high-performance, browser-based agent simulation engine.**
100,000 autonomous ants · 60 FPS · under 10 MB · one browser.

Ants explore, forage, carry food home, and lay pheromone trails. The colony's
intelligence is not programmed — it emerges from three sensor reads and a
handful of local rules.

This is not only an ant simulation. It is an **engine** for large-scale
agent-based simulation, with ants as the first application.

---

## Status

| Milestone | Population | State |
| --- | --- | --- |
| M0 Plan & skeleton | — | ✅ |
| M1 MVP correctness | 100 | ✅ |
| M2 V1 | 1,000 | ✅ |
| M3 V2 | 10,000 | ✅ |
| M4 V3 | 50,000 | ✅ |
| M5 V4 north star | **100,000** | ✅ 3.02M updates/s · 11.8 ms/tick · 6.94 MB |
| M6 V5 exploration | 1,000,000 | — |

Live numbers live in [BENCHMARKS.md](./BENCHMARKS.md). The plan and its
constraints live in [PLAN.md](./PLAN.md). The design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm run bench    # headless throughput benchmark
npm test         # determinism + memory + field tests
```

Deterministic replay: append any seed to the URL —

```
http://localhost:5173/?seed=42&ants=10000
```

---

## How it works

**No objects. No allocation.** Agents are a structure-of-arrays: one
`Float32Array` per field. 100K ants cost 2.8 MB, and the hot loop touches
sequential memory.

**Fixed 30 Hz simulation, 60 Hz render.** Integer-only random numbers from a
per-agent xorshift, so the same seed replays the same world, bit for bit.

**Pheromones are a quantised 8-bit field**, decayed and diffused with integer
maths, sampled with three sensor taps per ant per tick.

**Rendering happens inside the simulation worker** on an `OffscreenCanvas`.
Positions never cross a thread boundary, so population is nearly free to render.
WebGPU instanced quads with a procedural ant silhouette; WebGL2 fallback.

```
Main thread ──control──▶ Sim Worker ──▶ OffscreenCanvas ──▶ GPU
   (UI only)              (sim + render)
```

---

## Engineering targets

| Target | Value |
| --- | --- |
| Population | 100,000 autonomous agents |
| Frame time | ≤ 16.7 ms (p95) |
| Sim-owned memory | ≤ 10 MB |
| Throughput | 3,000,000 agent updates / sec |
| Determinism | bit-exact replay from seed |
| Stability | 1 hour, flat memory, no leaks |

The 10 MB figure is a **hard budget** on simulation-owned memory only, and it is
metered honestly. GPU and browser memory are reported separately, never folded
in.

---

## Licence

MIT
