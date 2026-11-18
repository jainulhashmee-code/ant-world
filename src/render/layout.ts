/**
 * Instance layout shared by the WebGPU and WebGL2 backends.
 *
 * 24 bytes per instance, written directly into an ArrayBuffer with two views —
 * floats for position/heading, packed RGBA bytes for colour. Both renderers
 * upload this exact buffer, so a backend can never silently diverge in layout.
 */

export const INSTANCE_BYTES = 24;
/** 24 bytes = 6 × f32 slots. */
export const INSTANCE_SLOTS = 6;

/** Byte offsets, mirrored in the shader attribute declarations. */
export const ATTR_POS = 0; // vec2<f32>
export const ATTR_DIR = 8; // vec2<f32>
export const ATTR_COLOR = 16; // unorm8x4
export const ATTR_SIZE = 20; // f32

/** Pack an RGBA colour, little-endian, matching `unorm8x4`. */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
}

export const COLOR_NEST = rgba(96, 66, 34);
export const COLOR_FOOD = rgba(74, 196, 104);
export const COLOR_ROCK = rgba(84, 82, 96);
export const COLOR_SEEKING = rgba(214, 196, 168);
export const COLOR_RETURNING = rgba(255, 178, 66);
