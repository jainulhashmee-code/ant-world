# Architecture

Companion to [PLAN.md](./PLAN.md). This is the *how*.

---

## 1. Process & thread topology

```
┌──────────────────────────── Main thread ────────────────────────────┐
│  index.html · UI overlay · controls · FPS/memory HUD                │
│  Owns: DOM, keyboard/mouse, URL seed parsing                        │
│  Does NOT own: simulation, canvas                                │
└───────────────┬─────────────────────────────────────────────────────┘
                │  postMessage (control only, ~1 msg/sec)
┌───────────────▼────────────── Sim Worker ───────────────────────────┐
│  OffscreenCanvas  ← transferred once at boot                        │
│                                                                     │
│  ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐     │
│  │ Simulation     │   │ Pheromone      │   │ Renderer         │     │
│  │ 30 Hz fixed    │──▶│ field 4 Hz     │──▶│ WebGPU or WebGL2 │     │
│  │ agent pool     │   │ diffuse+decay  │   │ instanced quads  │     │
│  └────────────────┘   └────────────────┘   └──────────────────┘     │
│  one rAF loop: accumulate dt → N sim ticks → 1 render              │
└─────────────────────────────────────────────────────────────────────┘
```

**Why rendering in the worker?** At 100K agents, positions are 800 KB/frame. Copying
them to the main thread 60×/s is 48 MB/s of memcpy plus GC pressure. Rendering
where the data already lives makes population *free* to scale. The main thread
stays responsive because it does almost nothing.

**Multi-worker (M4).** When `crossOriginIsolated === true` (COOP/COEP headers),
the world is split into vertical strips. Each strip worker owns its agents and
reads neighbours' pheromone rows from a `SharedArrayBuffer`. Strip boundary
staleness of 1 tick is acceptable and invisible. If isolation is unavailable we
run 1 worker — same code path, `workerCount = 1`.

Deployment therefore needs COOP/COEP:
`public/_headers` ships the Cloudflare Pages config; `vite.config.ts` sets the
same headers for dev. A documented fallback keeps the single-threaded build
working on any static host.

---

## 2. Coordinate space & world

- World is **4096 × 4096** world units, origin top-left, y down.
- Nest sits near the centre; food sources and obstacles are placed by seed.
- **Pheromone grid**: 1024 × 1024, so 1 cell = 4 world units.
- **Terrain grid**: 512 × 512, so 1 cell = 8 world units (walls are thick).
- **Spatial grid**: 256 × 256, so 1 cell = 16 world units (~agent interaction
  radius bucket). Cell size is tuned so mean occupancy at 100K ≈ 1.5.

Conversion helpers live in `core/units.ts` and are inlined by the optimizer.

---

## 3. Agent representation (SoA)

`src/sim/agents.ts` — one `AgentPool` class over parallel typed arrays.
Field order is chosen so hot fields (x, y, angle) sit at the start of each
array and are touched in the same loop iteration.

| Array | Type | Meaning |
| --- | --- | --- |
| `x`, `y` | `F32` | world position |
| `angle` | `F32` | heading, radians |
| `energy` | `U8` | 0 = dead, 255 = full |
| `state` | `U8` | `SEEKING · RETURNING · IDLE · NESTING · DEAD` |
| `flags` | `U8` | bit 0 alive, 1 carrying, 2..3 role |
| `food` | `U8` | carried load |
| `colony` | `U8` | colony id (V1: always 0) |
| `age` | `U16` | ticks lived |
| `speed` | `U8` | quantised, 0–255 → 0.2–1.4 units/tick |
| `rng` | `U32` | xorshift128 state (single 32-bit slot per ant) |

Each ant owns its RNG state, so parallelising over ant index ranges does not
change results — that is what makes multi-worker determinism feasible.

**Steering (per tick):** 3 pheromone samples (left/centre/right at a fixed
sensor offset), terrain probe ahead, neighbour separation via spatial grid,
then a weighted steer. Weights are consts in `config.ts` and are the only knobs
behaviour work touches.

**No allocation in the hot path.** Every scratch value is a local or a
preallocated array field. A per-tick `new` anywhere in `sim/` is a bug.

---

## 4. Pheromone field

Two 8-bit channels: `HOME` (deposited by returning ants) and `FOOD` (deposited
by laden ants marking the route). Foragers home in on `FOOD`, carriers track
`HOME`.

Per tick, each ant writes +1 into its cell (saturating). Every 8th tick:

1. **Decay** — `v -= v >> 5` (≈3% per 8 ticks, pure integer, no float).
2. **Diffuse** — 4-neighbour blur into the scratch buffer, then swap.

Diffusion is a separate cache-linear pass over 1M cells; at 4 Hz that is
4M cell-ops/sec — a small fraction of the 3M/s agent budget. Integer-only so it
can be moved to a worker or a compute shader without changing results.

Rendering: `R8Unorm` texture sampled with linear filtering and a colour ramp.
Uploaded at 20 Hz, not 60 — pheromone changes are slow, nobody notices, and it
saves 40 MB/s of PCIe traffic.

---

## 5. Tick loop

```
onFrame(now):
  dt = now - last
  accumulator += min(dt, 250ms)        // clamp after tab-switch
  while accumulator >= TICK_MS and ticks < MAX_CATCHUP:
      simulation.tick()
      accumulator -= TICK_MS
  renderer.render(simulation)
  hud.update()                          // ~4 Hz only
```

- `TICK_MS = 1000/30`, `MAX_CATCHUP = 5` (never spiral of death).
- Sim is never interpolated in V1 for simplicity; ants move ≤1.4 units/tick, so
  at 4096 world units the stutter is sub-pixel. Interpolation is a later,
  measured decision, not an assumption.

---

## 6. Determinism

- Single source of randomness: `Rng` (xorshift128), seeded once from the URL
  seed; each agent derives its own state from `(seed, index)` at creation.
- No `Math.random`, no `Date.now`, no `performance.now` inside `sim/`.
- Tick count is an integer, incremented exactly once per tick.
- Golden test: `seed=42`, run 3,000 ticks, FNV-1a hash of the agent pool →
  asserted in `tests/determinism.test.ts`. Any intentional behaviour change
  updates the hash in the same commit.

---

## 7. Renderer

Interface in `render/renderer.ts`:

```ts
interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  uploadAgents(pool: AgentPool, count: number): void;
  uploadPheromone(home: Uint8Array, food: Uint8Array, size: number): void;
  render(view: ViewState): void;
  readonly backend: 'webgpu' | 'webgl2';
  dispose(): void;
}
```

**Instances.** Per-ant: `x, y, angle, packed rgba` → 16 B, so 100K ants =
1.6 MB GPU. Written straight into a mapped/persistent buffer where supported.

**Geometry.** One unit quad, 2 triangles, instanced. The fragment shader draws
the ant silhouette (head sphere + thorax + gaster) procedurally — no sprite
atlas, no texture fetch, crisp at any zoom.

**Pheromone layer.** A full-screen quad under the ants, sampling the R8 field
through a blue-orange ramp, with `HOME` and `FOOD` additively blended.

**WebGL2 path.** Same shaders in GLSL ES 3.0, `drawArraysInstanced`. If
`WEBGL_multi_draw` is present we batch; otherwise a single instanced call.

**Camera.** Pan/zoom via uniform, not by moving geometry. Zoom range 0.05×–8×.

---

## 8. Memory accounting

`core/memory.ts` exposes `SimMemory` — every typed array the engine allocates is
registered at creation. The HUD reads `SimMemory.total()` directly, so the
displayed number cannot drift from reality: **nothing is measured by guesswork**.

---

## 9. Benchmark harness

`npm run bench` runs headless in Node with `--expose-gc`:

1. Build a world at population N.
2. Warm up 2 s (JIT).
3. Measure 5 × 5 s ticks/sec.
4. Assert memory via typed-array accounting.
5. Emit a Markdown row for `BENCHMARKS.md`.

Browser numbers come from the in-app HUD export (copies a JSON blob to the
clipboard) so hardware-specific results are attributable.

---

## 10. Repo layout

```
ant-world/
├─ PLAN.md · ARCHITECTURE.md · BENCHMARKS.md · README.md
├─ index.html
├─ vite.config.ts            # COOP/COEP headers, worker build
├─ public/_headers           # Cloudflare Pages isolation headers
├─ src/
│  ├─ main.ts                # boot: canvas → worker, wire HUD
│  ├─ core/    config · units · rng · memory
│  ├─ sim/     agents · world · pheromones · spatial · colony · simulation
│  ├─ worker/  sim.worker.ts · protocol.ts · loop.ts
│  ├─ render/  renderer · webgpu · webgl2 · shaders
│  ├─ ui/      overlay · hud
│  └─ bench/   bench.ts
└─ tests/      determinism · memory · pheromone
```

**Rule:** `sim/` must never import from `render/` or `ui/`. The engine is
headless-testable. That line is enforced by a lint rule, not by discipline.
