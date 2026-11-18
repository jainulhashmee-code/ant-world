# Ant World — Engineering Plan

> 100,000 agents. 60 FPS. Under 10 MB. One browser.

This document is the contract. Every milestone below has a measurable exit
criterion. If a criterion fails, the milestone is not done.

---

## 1. What we are building

An open-source, browser-based agent simulation **engine**, with an ant colony as
the first application. The engine is generic; the ant rules are a plugin.

```
┌──────────────────────────────────────────────────────────┐
│  Application layer (ant-specific)                        │
│  forage · pheromone rules · colony economy · rendering   │
├──────────────────────────────────────────────────────────┤
│  Engine layer (reusable)                                 │
│  SoA agent pools · deterministic PRNG · spatial grid      │
│  diffusion fields · fixed-step scheduler · job graph     │
└──────────────────────────────────────────────────────────┘
```

V1 ships the engine + ants. Boids, fish schools, traffic etc. are *proofs* of
genericity and arrive only when the engine is stable and benchmarked.

---

## 2. Non-negotiable constraints

| Constraint | Value | Rationale |
| --- | --- | --- |
| Sim-owned memory ceiling | **10 MB** | Forces compact representation. Non-negotiable from day one. |
| Frame budget | **16.7 ms** | 60 FPS. Sim + render + browser overhead. |
| Sim throughput | **3M agent updates/sec** | 100K ants × 30 ticks/s = exactly 3M. |
| Determinism | bit-exact replay | Fixed-step + explicit PRNG. No `Math.random`, no wall clock in sim. |
| Zero leaks over 1 hour | flat RSS | 216,000 ticks. No per-tick allocation in the hot path. |

### 2.1 How the 10 MB is spent (budgeted before we write code)

| Allocation | Representation | Bytes @ 100K ants |
| --- | --- | --- |
| Position x, y | `Float32Array` ×2 | 800 KB |
| Heading | `Float32Array` | 400 KB |
| Energy | `Uint8Array` (0–255) | 100 KB |
| State machine | `Uint8Array` | 100 KB |
| Flags (carrying, role, alive) | `Uint8Array` | 100 KB |
| Carried food | `Uint8Array` | 100 KB |
| Colony id | `Uint8Array` | 100 KB |
| Age / lifecycle | `Uint16Array` | 200 KB |
| Speed (quantised) | `Uint8Array` | 100 KB |
| PRNG state | `Uint32Array` | 400 KB |
| Spatial grid (next-links) | `Int32Array` | 400 KB |
| **Agent pool subtotal** | | **2.80 MB** |
| Spatial grid cell heads | 256×256 `Int32Array` | 256 KB |
| Pheromone *home* | 1024×1024 `Uint8Array` | 1.00 MB |
| Pheromone *food* | 1024×1024 `Uint8Array` | 1.00 MB |
| Diffusion scratch | 1024×1024 `Uint8Array` | 1.00 MB |
| Terrain / obstacles | 512×512 `Uint8Array` | 256 KB |
| Food source table | 512 × 8 B | 4 KB |
| Colony / nest state | handful of scalars | <1 KB |
| **Field + world subtotal** | | **3.52 MB** |
| Headroom for V3/V4 (swap buffers, denser grid, LOD) | | **3.68 MB** |
| **Total** | | **10.0 MB** |

Headroom is deliberate. Doubling the pheromone resolution to 2048² costs 4 MB
and would break the budget — so resolution is a *quality dial that is capped*,
not free.

### 2.2 What is *not* sim memory

These are counted separately and reported separately, never conflated with the
10 MB figure:

- **GPU memory** — instance buffers, textures, pipelines.
- **JS heap from UI** — DOM, HUD strings, event listeners.
- **Browser baseline** — V8, compositor, WebGPU driver.

A HUD line reports all three. A benchmark that only quotes the 10 MB number
without the others is dishonest.

---

## 3. Architecture decisions

### ADR-001 — Structure-of-Arrays, never objects
100K objects × ~200 B = 20 MB before we start. SoA with typed arrays keeps the
agent working set cache-resident and allocation-free. **Rejected:** arrays of
classes, `Map<id, ant>`, ECS with string keys.

### ADR-002 — Fixed timestep, integer PRNG
Sim ticks at a fixed 30 Hz (decoupled from the 60 Hz render). Every random draw
comes from a per-agent xorshift128 state seeded deterministically. Replay of the
same seed produces a bit-identical world. **Rejected:** `Math.random`,
`performance.now()` inside sim, variable dt.

### ADR-003 — Pheromones are a quantised field, not objects
An 8-bit grid with exponential decay, diffused on a slower cadence than agent
movement. Agents do 3-tap bilinear sampling. **Rejected:** pheromone entities,
float fields, per-ant trail objects.

### ADR-004 — Uniform spatial hash, rebuilt each tick
Counting-sort style grid: `cellHead[]` + `next[]`, O(n), zero allocation,
rebuilt every tick. Used for neighbour avoidance and food queries.
**Rejected:** quadtrees, k-d trees (pointer chasing, allocation, worse at 100K).

### ADR-005 — Simulation lives in a dedicated Web Worker
The main thread does UI and input only. Renderer runs on the worker's
`OffscreenCanvas`, so positions never cross the thread boundary — zero-copy at
any population. Multi-worker scaling (SAB + spatial domain decomposition) is
layered on later and **degrades gracefully** to a single worker when
`crossOriginIsolated` is false.

### ADR-006 — WebGPU first, WebGL2 fallback, never Canvas2D for the swarm
100K instanced quads. WebGPU is the primary path; WebGL2 instanced arrays cover
Safari and older devices. Both consume the *same* instance buffer layout.

### ADR-007 — Correctness before speed, always
Each milestone has golden-state tests (seed → hash of world after N ticks).
Optimisation commits must not change the hash unless intentionally, and the
change is then called out.

---

## 4. Milestones

Each ends in a commit, a benchmark run, and a pushed result table.

### M0 — Plan & skeleton ✅
Repo, plan, architecture, docs, benchmark contract.

**Exit:** docs committed; `npm run dev` serves an empty canvas.

### M1 — MVP: 100 ants, correct behaviour
One nest, 100 ants, 4 food sources, obstacles, two pheromone channels, full
forage loop (explore → find → carry → return → deposit). Deterministic.

**Exit:** ants reliably complete the loop; food counter climbs; seed replay
matches golden hash; sim memory < 1 MB.

### M2 — V1: 1,000 ants @ 60 FPS
Worker + OffscreenCanvas + WebGPU renderer + WebGL2 fallback + HUD.

**Exit:** 60 FPS sustained 60 s; sim memory < 1.5 MB; throughput > 3M
updates/s.

### M3 — V2: 10,000 ants
Grid crowding, neighbour avoidance, pheromone cadence tuning, GPU instance
upload strategy.

**Exit:** 60 FPS; < 3 MB; throughput ≥ 3M updates/s (measured, not inferred).

### M4 — V3: 50,000 ants
Multi-worker (SAB when isolated), domain decomposition, LOD rendering.

**Exit:** 60 FPS; < 8 MB; scaling efficiency ≥ 60% on 4 workers.

### M5 — V4: 100,000 ants
Final tuning pass, memory audit, leak test.

**Exit:** **60 FPS, 10 MB, 3M updates/s, 1-hour flat memory** — the north star.

### M6 — V5: 1M (exploration)
GPU-compute agents (WebGPU compute shaders) or distributed. Exploratory; the
browser memory budget makes 1M CPU-side agents impossible, so this is an
explicitly different architecture.

---

## 5. Measurement contract

All numbers validated on a **declared machine**, recorded in `BENCHMARKS.md`,
reproducible with `npm run bench`.

Measured independently:

| Metric | How |
| --- | --- |
| Sim memory | Sum of typed-array `byteLength` owned by the engine (`SimMemory.accounting()`), plus `measureUserAgentSpecificMemory()` where available |
| Agent throughput | Ticks/sec × population, warmed up 2 s, median of 5 runs, headless |
| Frame time | `requestAnimationFrame` delta p50/p95/p99 over 600 frames |
| Render-only cost | GPU timestamp queries (WebGPU) + frame time with sim paused |
| Leaks | 1-hour soak, memory sampled every 60 s, linear-regression slope must be ≈ 0 |

**Anti-cherry-picking rules:** no reporting p50 alone; report p95/p99 frame
times; publish the machine spec; publish the commit hash.

---

## 6. What "done" looks like for V4

Open `https://<repo>.pages.dev` on a laptop:

- 100,000 ants forage, trail, and return food.
- HUD reads 60 FPS, ~9.x MB sim, ~3.0M updates/s.
- Let it run an hour: memory flat, no GC sawtooth, no tab crash.
- Paste the seed into the URL: identical world, frame for frame.
- Toggle population with a slider: 100 → 100,000 without reload.

That is the north star. Everything in this plan exists to make that boring.
