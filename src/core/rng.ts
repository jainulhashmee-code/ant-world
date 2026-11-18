/**
 * Deterministic RNG primitives.
 *
 * Rules of the house:
 *  - `Math.random` is banned inside `src/sim`.
 *  - Every agent owns its own 32-bit state, so agent i's draws are independent
 *    of agent j's. That is what makes domain-decomposed multi-worker simulation
 *    produce identical results to a single-worker run.
 *  - No allocation, no BigInt, no floating point in state evolution.
 */

/** Advance a xorshift32 state and return the new state. */
export function nextU32(state: number): number {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

/** Convert a 32-bit state to a float in [0, 1). */
export const U32_TO_F32 = 1 / 4294967296;

/**
 * SplitMix32 — used only at construction time to derive independent per-agent
 * seeds from a single world seed. Never called in the hot loop.
 */
export function splitmix32(seed: number): number {
  seed = (seed + 0x9e3779b9) >>> 0;
  let z = seed;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** Derive a per-agent seed. Agents with different indices never correlate. */
export function seedFor(index: number, worldSeed: number): number {
  // Mix index and seed so that e.g. (index=1, seed=2) and (index=2, seed=1)
  // differ. A zero state would lock xorshift at zero, hence the guard.
  const mixed = splitmix32(Math.imul(index + 1, 0x85ebca6b) ^ (worldSeed + 0x165667b1));
  return mixed === 0 ? 0x9e3779b9 : mixed;
}

/** FNV-1a over a byte view. Used for golden-hash determinism tests. */
export function fnv1a(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
