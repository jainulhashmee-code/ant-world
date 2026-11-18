/**
 * Uniform spatial hash, rebuilt every tick with a counting-sort style pass.
 *
 * O(n), zero allocation, cache-friendly: `heads` is `size² × 4` bytes and
 * `next` is 4 bytes per agent. A quadtree would allocate, pointer-chase, and be
 * slower at 100K entities — hence the boring choice.
 */

import { mem } from '../core/memory';
import { WORLD, gridCellWorld } from '../core/config';
import type { AgentPool } from './agents';

export class SpatialGrid {
  readonly size: number;
  readonly cellCount: number;
  readonly invCell: number;

  /** Index of the first agent in each cell, or -1. */
  readonly heads: Int32Array;
  /** Linked-list `next` pointer per agent, or -1. */
  readonly next: Int32Array;
  /** Cell index per agent from the last build. */
  readonly cellOf: Int32Array;

  constructor(size: number, capacity: number) {
    this.size = size;
    this.cellCount = size * size;
    this.invCell = 1 / gridCellWorld(size);

    this.heads = mem.i32('grid.heads', this.cellCount);
    this.next = mem.i32('grid.next', capacity);
    this.cellOf = mem.i32('grid.cellOf', capacity);
  }

  /** Rebuild for the current population. Allocation-free. */
  build(pool: AgentPool, count: number): void {
    const heads = this.heads;
    heads.fill(-1);

    const x = pool.x;
    const y = pool.y;
    const next = this.next;
    const cellOf = this.cellOf;
    const inv = this.invCell;
    const last = this.size - 1;

    for (let i = 0; i < count; i++) {
      let gx = (x[i] * inv) | 0;
      let gy = (y[i] * inv) | 0;
      if (gx < 0) gx = 0;
      else if (gx > last) gx = last;
      if (gy < 0) gy = 0;
      else if (gy > last) gy = last;
      const c = gy * this.size + gx;
      cellOf[i] = c;
      next[i] = heads[c];
      heads[c] = i;
    }
  }

  /** Cell index for a world position, clamped to the grid. */
  cellIndexAt(wx: number, wy: number): number {
    const inv = this.invCell;
    const last = this.size - 1;
    let gx = (wx * inv) | 0;
    let gy = (wy * inv) | 0;
    if (gx < 0) gx = 0;
    else if (gx > last) gx = last;
    if (gy < 0) gy = 0;
    else if (gy > last) gy = last;
    return gy * this.size + gx;
  }

  /** Mean agents per cell, used by the benchmark to sanity-check density. */
  meanOccupancy(count: number): number {
    return count / this.cellCount;
  }
}

void WORLD;
