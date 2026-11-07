// Turns the frames a device streams into the RGB images rexsim draws, with
// the screen's corners rounded into the pane's background.
import type { Platform } from "../device";
import type { RGB } from "./theme";

// cornerRadius is the corner radius in pixels of a screen drawn width by
// height. The framebuffer is square, so rexsim rounds it the way the
// hardware is: iPhones are about 55 points on 402, iPads about 18 on 820.
// An emulator's system UI assumes square corners and puts the status bar
// right against them, so its rounding stays small enough to keep the clock
// whole. The radius follows the short side, so a turned screen rounds the
// same.
export function cornerRadius(width: number, height: number, platform: Platform = "ios"): number {
  const short = Math.min(width, height);
  if (platform === "android") return 0.035 * short;
  return (short / Math.max(width, height) < 0.6 ? 0.137 : 0.022) * short;
}

// cornerMask holds the anti-aliased coverage of a top-left corner of radius
// r, row by row.
export function cornerMask(r: number): Uint8Array {
  const m = new Uint8Array(r * r);
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const d = Math.hypot(r - (x + 0.5), r - (y + 0.5));
      m[y * r + x] = Math.min(Math.max(r - d + 0.5, 0), 1) * 255;
    }
  }
  return m;
}

// toRGB converts BGRA pixels, whose rows are stride bytes apart, to tightly packed RGB, and blends the corners
// outside the screen's radius into bg. It reads a whole little-endian pixel
// at a time, which needs the source 4-byte aligned; protobuf hands over the
// frame at any offset, so a misaligned one is copied first. The copy uses
// the Uint8Array constructor because Buffer's slice returns a view. It
// writes into out when out has the right size.
export function toRGB(
  pix: Uint8Array, width: number, height: number, stride: number, mask: Uint8Array, r: number, bg: RGB,
  out?: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const dst = out?.length === width * height * 3 ? out : new Uint8Array(width * height * 3);
  const src = pix.byteOffset % 4 === 0 ? pix : new Uint8Array(pix);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2);
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2);
  const rowWords = stride >>> 2;
  const rgb = (v: number) => ((v >>> 16) & 0xff) | (v & 0xff00) | ((v & 0xff) << 16);
  // Four pixels fill three words. A row whose length isn't a multiple of
  // four leaves part of a word for the next row, which push carries.
  let o = 0;
  let phase = 0;
  let acc = 0;
  const push = (v: number) => {
    if (phase === 0) acc = v;
    else if (phase === 1) (d32[o++] = acc | (v << 24)), (acc = v >>> 8);
    else if (phase === 2) (d32[o++] = acc | (v << 16)), (acc = v >>> 16);
    else (d32[o++] = acc | (v << 8)), (acc = 0);
    phase = (phase + 1) & 3;
  };
  for (let y = 0; y < height; y++) {
    let j = y * rowWords;
    const end = j + width;
    while (phase !== 0 && j < end) push(rgb(s32[j++]));
    for (; j + 4 <= end; j += 4) {
      const p0 = rgb(s32[j]);
      const p1 = rgb(s32[j + 1]);
      const p2 = rgb(s32[j + 2]);
      const p3 = rgb(s32[j + 3]);
      d32[o++] = p0 | (p1 << 24);
      d32[o++] = (p1 >>> 8) | (p2 << 16);
      d32[o++] = (p2 >>> 16) | (p3 << 8);
    }
    while (j < end) push(rgb(s32[j++]));
  }
  for (let k = o * 4; k < dst.length; k++, acc >>>= 8) dst[k] = acc;
  fillCorners(dst, width, height, mask, r, bg);
  return dst;
}

// turn rotates BGRA pixels, whose rows are stride bytes apart, by quarter
// turns clockwise into packed rows, reusing out when it has the right size.
// Like toRGB it reads whole pixels, so a misaligned source is copied first.
export function turn(
  pix: Uint8Array, width: number, height: number, stride: number, turns: number, out?: Uint8Array<ArrayBuffer>,
): { pix: Uint8Array<ArrayBuffer>; width: number; height: number } {
  turns &= 3;
  const dst = out?.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
  const src = pix.byteOffset % 4 === 0 ? pix : new Uint8Array(pix);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2);
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2);
  const rowWords = stride >>> 2;
  for (let y = 0; y < height; y++) {
    const row = y * rowWords;
    for (let x = 0; x < width; x++) {
      const k =
        turns === 1 ? x * height + height - 1 - y
        : turns === 2 ? (height - 1 - y) * width + width - 1 - x
        : turns === 3 ? (width - 1 - x) * height + y
        : y * width + x;
      d32[k] = s32[row + x];
    }
  }
  return turns % 2 === 1 ? { pix: dst, width: height, height: width } : { pix: dst, width, height };
}

// fillCorners blends the corners of packed RGB pixels outside the screen's
// radius into bg, in place.
export function fillCorners(dst: Uint8Array, width: number, height: number, mask: Uint8Array, r: number, bg: RGB): void {
  const maskWidth = r;
  r = Math.min(r, Math.trunc(width / 2), Math.trunc(height / 2));
  const blend = (k: number, a: number) => {
    for (let c = 0; c < 3; c++) dst[k + c] = (dst[k + c] * a + bg[c] * (255 - a) + 127) / 255;
  };
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const a = mask[y * maskWidth + x];
      if (a === 255) continue;
      blend((y * width + x) * 3, a);
      blend((y * width + width - 1 - x) * 3, a);
      blend(((height - 1 - y) * width + x) * 3, a);
      blend(((height - 1 - y) * width + width - 1 - x) * 3, a);
    }
  }
}
