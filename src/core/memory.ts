/**
 * Simulation-owned memory accounting.
 *
 * Every typed array the engine allocates goes through this module, so the
 * figure reported to the HUD / benchmark cannot drift from reality. Nothing
 * here is estimated or sampled.
 *
 * Scope: simulation-owned memory ONLY. GPU buffers, the DOM, and the browser
 * baseline are measured separately and never folded into the 10 MB budget.
 */

export interface MemEntry {
  readonly label: string;
  readonly bytes: number;
  readonly count: number;
}

export class SimMemory {
  private entries: MemEntry[] = [];
  private bytes = 0;

  private note(label: string, array: { byteLength: number; length: number }): void {
    this.entries.push({ label, bytes: array.byteLength, count: array.length });
    this.bytes += array.byteLength;
  }

  f32(label: string, n: number): Float32Array<ArrayBuffer> {
    const a = new Float32Array(n);
    this.note(label, a);
    return a;
  }

  u8(label: string, n: number): Uint8Array<ArrayBuffer> {
    const a = new Uint8Array(n);
    this.note(label, a);
    return a;
  }

  u16(label: string, n: number): Uint16Array<ArrayBuffer> {
    const a = new Uint16Array(n);
    this.note(label, a);
    return a;
  }

  u32(label: string, n: number): Uint32Array<ArrayBuffer> {
    const a = new Uint32Array(n);
    this.note(label, a);
    return a;
  }

  i32(label: string, n: number): Int32Array<ArrayBuffer> {
    const a = new Int32Array(n);
    this.note(label, a);
    return a;
  }

  /** Total simulation-owned bytes. */
  total(): number {
    return this.bytes;
  }

  totalMB(): number {
    return this.bytes / (1024 * 1024);
  }

  /** Largest allocations first — useful for budget work. */
  report(): MemEntry[] {
    return [...this.entries].sort((a, b) => b.bytes - a.bytes);
  }

  /** Human-readable budget table. */
  table(): string {
    const rows = this.report().map(
      (e) => `${e.label.padEnd(28)} ${(e.bytes / 1024).toFixed(1).padStart(9)} KB`,
    );
    const total = (this.bytes / 1024).toFixed(1).padStart(9);
    return [...rows, `${'TOTAL'.padEnd(28)} ${total} KB`].join('\n');
  }
}

/** Process-wide simulation memory ledger. */
export const mem = new SimMemory();

/** Reset for tests (a fresh world rebuild re-registers). */
export function resetMemory(): void {
  // A pre-recording snapshot is enough for the tests; the SimMemory instance is
  // shared so that the HUD always reflects live allocations.
  (mem as unknown as { entries: MemEntry[] }).entries = [];
  (mem as unknown as { bytes: number }).bytes = 0;
}
