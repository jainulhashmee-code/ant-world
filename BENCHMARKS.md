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

### Findings

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


### Sim throughput (headless, Node)

| Commit | Population | Ticks/s | Updates/s | Sim memory | Notes |
| --- | --- | --- | --- | --- | --- |
| _pending M1_ | 100 | | | | |

### Browser frame time

| Commit | Population | Backend | p50 | p95 | p99 | Sim mem | GPU mem | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _pending M2_ | 1,000 | | | | | | | |

### Soak (1 hour)

| Commit | Population | Start RSS | End RSS | Slope MB/min | Result |
| --- | --- | --- | --- | --- | --- |
| _pending M5_ | 100,000 | | | | |
