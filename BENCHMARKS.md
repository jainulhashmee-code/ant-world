# Benchmarks

Numbers, hardware, commit. No marketing.

## Contract

- **Sim memory** = sum of `byteLength` of every typed array the engine allocates
  (`SimMemory.total()`). Excludes GPU, DOM, and browser baseline — those are
  reported in separate columns.
- **Throughput** = population × ticks/sec, measured in Node headless after a 2 s
  JIT warmup, median of 5 runs of 5 s each.
- **Frame time** = `requestAnimationFrame` delta over 600 frames; p50 **and**
  p95/p99 always reported together. A p50 alone is not a result.
- Every row is tied to a commit hash. Results produced on different hardware are
  never averaged.

Run locally: `npm run bench` (writes a Markdown row to stdout).

---

## Reference hardware

| | |
| --- | --- |
| Machine | MacBook Air (M4, 2025) |
| Chip | Apple M4 — 10 cores (4P + 6E) |
| Memory | 16 GB unified |
| OS | macOS 26.4.1 |
| Browser | Chrome (WebGPU enabled by default) |

Results on other machines are welcome as PRs — add a row, keep the hardware
column honest.

---

## Milestone targets

| Milestone | Population | Frame time p95 | Sim memory | Throughput |
| --- | --- | --- | --- | --- |
| M1 MVP | 100 | n/a (headless) | < 1.0 MB | informational |
| M2 V1 | 1,000 | ≤ 16.7 ms | < 1.5 MB | > 3M/s |
| M3 V2 | 10,000 | ≤ 16.7 ms | < 3.0 MB | ≥ 3M/s |
| M4 V3 | 50,000 | ≤ 16.7 ms | < 8.0 MB | ≥ 3M/s |
| M5 V4 | **100,000** | **≤ 16.7 ms** | **< 10 MB** | **3M/s** |

---

## Results

> Populated as milestones land. Empty until then — no placeholder numbers.

### M1 — simulation core, headless

Commit: _see git log_. Population sweep, `npm run bench`, macOS 26.4.1 / Node 26.10.0.

| Population | Ticks/s | Updates/s | Sim memory | Field | Notes |
| --- | --- | --- | --- | --- | --- |
| 100 | 21,026 | 2.10M | 0.46 MB | 256² | Field update dominates at low population |
| 1,000 | 5,885 | 5.88M | 0.49 MB | 256² | |
| 10,000 | 375 | 3.75M | 1.41 MB | 512² | |
| 100,000 | 7 | 0.68M | 6.93 MB | 1024² | **4.4× short of target** |

> **Superseded.** These rows predate the separation LOD, the energy fix and the
> larder change, and the harness itself had a bug (see finding 5 — it forced
> separation on). They are kept only as the historical starting point; the
> current numbers are the M5 tables below. Do not compare against them.

### Findings — headless (M1)

**1. A V8 OSR cliff cost 2.6×, and it was invisible to the profiler.**

The first implementation inlined the 3×3 neighbour scan inside the per-agent
loop. `node --trace-deopt` showed the frame repeatedly deoptimising:

```
bailout (kind: deopt-eager, reason: exit from OSR'd inner loop):
  deoptimizing <JSFunction step> ... bytecode offset 2449
```

`step` was re-compiled every few ticks, so the hot loop spent much of its time
in unoptimised code. Moving the neighbour scan into `separateFrom()` and the
loop into `stepAgents()` took 10,000 ants from **1.45M → 3.75M updates/s**.

Lesson recorded for the project: `--cpu-prof` reported 96.7% of samples inside
`step`, which is true and useless. `--trace-deopt` found the actual problem.

**2. 100,000 agents is 3.7× worse than linear extrapolation from 10,000.**

10K costs 2.7 ms/tick; 100K costs 143 ms/tick. Linear would be 27 ms. The
suspects, in order: neighbour-scan candidate count (density grows 2.5× per ant
as the grid gets populated), pheromone random reads exceeding L2 working set,
and grid build `fill(-1)` over 65K heads. This is the first real optimisation
target and the next commit measures it rather than guessing.

**Resolved, and the answer was none of the three.** A/B with `--nosep` isolated
pairwise separation as responsible for essentially all of it:

| 100,000 agents | Ticks/s | Updates/s |
| --- | --- | --- |
| separation on | 7 | 0.68M |
| separation off | 64 | 6.37M |

**9.3× for a pass that does nothing at that density.** Mean nearest-neighbour
spacing at 100K is ~13 world units against a 4.5-unit separation radius, so the
correction almost never fires — but every ant still pays to search its 3×3
neighbourhood to discover that. It is now a population-gated LOD
(`SEPARATION_MAX_POP`), active below 20,000 where spacing is tight enough for it
to shape the swarm, off above it where it is invisible.

The general lesson: this was found by disabling a feature and re-running, not by
profiling. A sampler attributes the time correctly to a pass that should not be
running at all.

**3. The separation LOD threshold is the dominant tunable now.**

Measured back-to-back on the M5 commit, forcing the pass either way:

| Population | Forced on | Forced off | Cost of separation |
| --- | --- | --- | --- |
| 1,000 | 3.57M | 11.14M | **3.1×** |
| 10,000 | 2.85M | 19.44M | **6.8×** |

The cost grows with density, which is the shape the LOD needs: cheap and useful
when the swarm is sparse, ruinous when it is dense. `SEPARATION_MAX_POP = 20,000`
sits deliberately above 10,000, so the pass is paid where it visibly shapes the
swarm.

**4. The benchmark was measuring a configuration the app never runs.**

`bench.ts` defaulted to `separation: true` and passed it explicitly, which
overrode the population-based LOD. Headless reported **0.69M updates/s at
100,000 agents** while the same machine, same commit, ran **3.02M in the
browser** — the harness had forced on a pass the app switches off above 20,000.

The tell was simple and should have been checked sooner: two measurements of the
same code disagreeing by 4.4×. Either the browser is lying or the harness is not
running the code you think it is. It is nearly always the second one. The default
is now `undefined` so the LOD decides, and `--sep` exists for anyone who wants the
forced number deliberately.

---

### M5 — headless throughput

macOS 26.4.1 / Node 26.10.0. Separation follows the shipped population LOD by
default; `--sep` / `--nosep` force it either way.

| Population | Ticks/s | Updates/s | Sim memory | Field | Separation |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 3,214 | 3.21M | 0.49 MB | 256² | on (LOD) |
| 10,000 | 274 | 2.74M | 1.41 MB | 512² | on (LOD) |
| 100,000 | 204 | **20.35M** | 6.94 MB | 1024² | off (LOD) |

### M5 — in-browser, 100,000 agents

Chrome, WebGPU on Apple Metal-3, `?seed=7&ants=100000`, headed window. Read from
the HUD's own stats payload after 176 s of simulation (5,281 ticks — long enough
to pass the 1,600-tick energy cliff, which earlier samples did not).

| Population | Backend | FPS | p50 | p95 | p99 | Sim/tick | Render | Sim mem | Updates/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | WebGPU | 57–60 | 16.7–17.3 ms | 17.3 ms | 18.5 ms | 6.8–7.6 ms | 1.6 ms | 6.94 MB | 2.93M |
| 10,000 | WebGPU | 60.0 | 16.67 ms | 17.07 ms | 17.55 ms | 2.88 ms | 0.25 ms | 1.41 MB | 0.30M |

FPS is a range because it is sampled, not averaged over the session: across
samples at 100,000 agents the p50 moved between 16.67 and 17.26 ms. Colony
behaviour over one 176 s run: **183,000 deliveries**, 1,040/s, with 74% of all
harvested food arriving at the nest (the rest still in transit).

Colony behaviour over that run: **183,000 deliveries**, 1,040/s, with 74% of all
harvested food arriving at the nest (the rest still in transit).

Read this honestly:

- **"2.93M updates/s" is a schedule being met, not a capacity.** The sim runs a
  fixed 30 Hz, so `updates/s` at 100,000 agents is 100,000 × 30 by construction —
  it reads the same on a fast machine and a slow one. What actually varies is
  `sim/tick`: 7.6 ms against a 33.3 ms budget, i.e. **4.4× headroom** (~131
  ticks/s of capacity in-browser). The honest claim is "holds 30 Hz at 100,000
  agents with 4.4× headroom", not the 3M figure.
- **Sim memory is 6.94 MB against a 10 MB budget**, and that number is the sum
  of every typed array the engine allocates, not an estimate.
- **Frames hold 60 fps at 100,000 agents**: p50 16.67 ms, p95 17.33 ms, p99
  18.53 ms. An earlier run of the same commit measured p95 22.33 ms; the
  difference is the energy fix removing the per-tick starvation branch (a
  `sin`/`cos` respawn scatter), which cut `sim/tick` from 11.8 ms to 7.6 ms.
  That is a useful reminder that at 100,000 agents, *behaviour* is a
  performance variable.
- **Revivals are 685/s at steady state** (120,654 over the run) — about 1.2
  restarts per ant per three minutes. Lower is better and this is the clearest
  remaining behaviour cost: those are ants that never found a source, dying at
  the 1,600-tick energy cliff. Productive ants now persist, which took
  deliveries from 188/s to 1,040/s, but the lost-ant churn is the next thing to
  fix.
- `updates/s` at 10,000 reads 0.30M because that *is* correct: 10,000 agents ×
  30 Hz. Colouring it green only at 3M/s — which is what the HUD did at first —
  marks a healthy 10K colony as failing. It is now coloured against whether the
  sim holds its own 30 Hz step.

### Findings — in-browser (M5)

**1. The FPS counter was measuring the wrong thing, and it hid a wasted loop.**

The loop reported 316 fps at 10,000 ants. It was not running at 316 fps; it was
computing `1000 / (mean time spent doing work)` and calling that FPS. Real frame
interval was never measured, and nothing paced the loop at all — worker
`requestAnimationFrame` fired ~5× faster than the display, so ~80% of frames
rendered into a canvas nobody would see.

Two separate bugs wearing one costume:

```
fps = 1000 / workTime      // 3 ms of work reported as "333 fps"
```

Fixed by storing the **interval** between frames (`t0 - lastFrame`) for
p50/p95/p99 and by gating the scheduler on a 16.7 ms deadline. Result: exactly
60.0 fps, p50 16.67 ms. A display loop with no pacing will happily burn a core
producing frames that never reach a screen, and a throughput metric built from
work time will report it as excellent.

**2. `postMessage` without a transfer list fails silently and looks like a
   hung GPU.**

The main thread sent the `OffscreenCanvas` without listing it in the transfer
array. `postMessage` throws `DataCloneError`, the worker never receives `init`,
and the UI sits on "booting…" forever with **no console error**, because
`worker.onerror` does not fire for a throw inside the posting thread and the
worker itself never failed.

The diagnostic that worked was elimination: modules all returned 200, WebGL2 was
present, `navigator.gpu` existed — so the worker must be alive and waiting. From
there, "what does it never receive?" answers it in one step.

**3. An unbounded GPU handshake turns a bad driver into a black screen.**

`navigator.gpu.requestAdapter()` can hang indefinitely rather than reject. Every
GPU step is now wrapped in a 4 s timeout that falls back to WebGL2, and the
whole boot path is one `try/catch` that reports to the UI — because unhandled
rejections inside a worker do not surface through `onerror` either.

**4. A fixed food budget starves a 100,000-ant colony in 70 seconds.**

Not a rendering issue: at 100K the colony ate the world bare in about a minute,
after which 96,000 ants wandered with nothing to do and the whole frame turned
into a milky smear of idle agents. The larder now scales with population
(`FOOD_PER_ANT`), so the forage loop stays meaningful at every population. Worth
recording because it is the failure mode of every "scale it up" demo: the
constants that made 100 agents look alive are invisible at 100,000.

**5. Energy refilled only on delivery, so most ants starved carrying food.**

Spawn energy is 200 and decay is 1 per 8 ticks, so lifespan is 1,600 ticks. The
far food sources sit over 1,300 world units from the nest. Any ant whose round
trip outlasted its lifespan starved in transit and dropped its load — which at
100,000 agents was most of the colony. Food left the sources and never arrived.

Finding food now restores energy, because a forager standing on a food source has
by definition eaten. Measured at 100,000 agents, before → after:

| | Deliveries/s | Revivals/s | Food arriving |
| --- | --- | --- | --- |
| energy on delivery only | 188 | 1,483 | ~0% |
| energy restored at food | 1,040 | 685 | 74% |

Two process notes, because both nearly produced a false claim:

- The first "revivals are now zero" reading was taken at tick 1,401 — **before**
  the 1,600-tick cliff, so no ant could have died yet. It proved nothing. Check
  the measurement window against the mechanism's timescale before believing a
  clean result.
- The matching unit test failed at 4,000 agents with 84% of ants recycling, which
  looked like the fix not working. It was map luck: at low density most ants
  never find a source at all. The test now asserts the mechanism (a laden ant
  cannot be running on fumes) rather than colony economics.

Revivals at 685/s are the clearest remaining behaviour cost: those are still ants
that never found food, dying at the cliff. That is the next thing to fix, not
something the energy change solved.

### Soak (1 hour)

| Commit | Population | Start RSS | End RSS | Slope MB/min | Result |
| --- | --- | --- | --- | --- | --- |
| — | 100,000 | — | — | — | **not yet run** |

The README lists "1 hour, flat memory, no leaks" as a target. It has not been
measured yet, so there is no row here. The longest continuous run so far is
~9 minutes at 100,000 agents (the 176 s sample above plus the larder-drain run),
during which sim memory stayed pinned at 6.94 MB — that is encouraging and it is
not a soak test. A real one needs a fixed-duration harness sampling
`SimMemory.total()` and RSS, because "I watched it for a while" is not evidence
of flat memory.
