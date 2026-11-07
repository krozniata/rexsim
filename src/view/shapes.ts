import type { Platform } from "../device";
import type { Image } from "../terminal/kitty";
import type { RGB } from "./theme";

// screenRadius is a phone's screen corner radius as a fraction of its width.
// The framebuffer is square, so rexsim rounds it the way the hardware is.
// iPhones are about 55 points on 402; iPads about 18 on 820. An emulator's
// system UI assumes square corners and puts the status bar right against
// them, so its rounding stays small enough to keep the clock whole, and
// follows the short side so a turned screen rounds the same.
export function screenRadius(aspect: number, platform: Platform = "ios"): number {
  if (platform === "android") return 0.035 / Math.max(1, aspect);
  return aspect < 0.6 ? 0.137 : 0.022;
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

// toRGBA converts BGRA pixels, or RGBA ones when bgra is false, whose rows
// are stride bytes apart, to tightly packed opaque RGBA, and makes the
// corners outside the screen's radius transparent. It works a whole
// little-endian pixel at a time, which needs the source 4-byte aligned;
// protobuf hands over the frame at any offset, so a misaligned one is copied
// first. The copy uses the Uint8Array constructor because Buffer's slice
// returns a view. It writes into out when out has the right size.
export function toRGBA(
  pix: Uint8Array, width: number, height: number, stride: number, mask: Uint8Array, r: number, bgra = true,
  out?: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const dst = out?.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
  const d32 = new Uint32Array(dst.buffer);
  const src = pix.byteOffset % 4 === 0 ? pix : new Uint8Array(pix);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2);
  const rowWords = stride >>> 2;
  let i = 0;
  for (let y = 0; y < height; y++) {
    const end = y * rowWords + width;
    if (bgra) {
      for (let j = y * rowWords; j < end; j++) {
        const v = s32[j];
        d32[i++] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
      }
    } else {
      for (let j = y * rowWords; j < end; j++) d32[i++] = s32[j] | 0xff000000;
    }
  }
  clearCorners(dst, width, height, mask, r);
  return dst;
}

// rgbToRGBA turns packed RGB pixels into opaque RGBA with the corners
// outside the screen's radius transparent, for when the background is
// unknown.
export function rgbToRGBA(pix: Uint8Array, width: number, height: number, mask: Uint8Array, r: number, out?: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const dst = out?.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; j < dst.length; i += 3, j += 4) {
    dst[j] = pix[i];
    dst[j + 1] = pix[i + 1];
    dst[j + 2] = pix[i + 2];
    dst[j + 3] = 255;
  }
  clearCorners(dst, width, height, mask, r);
  return dst;
}

function clearCorners(dst: Uint8Array, width: number, height: number, mask: Uint8Array, r: number): void {
  const maskWidth = r;
  r = Math.min(r, Math.trunc(width / 2), Math.trunc(height / 2));
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const a = mask[y * maskWidth + x];
      dst[(y * width + x) * 4 + 3] = a;
      dst[(y * width + width - 1 - x) * 4 + 3] = a;
      dst[((height - 1 - y) * width + x) * 4 + 3] = a;
      dst[((height - 1 - y) * width + width - 1 - x) * 4 + 3] = a;
    }
  }
}

// toRGB is toRGBA for a background that is known: it blends the corners
// outside the screen's radius into bg and leaves out the alpha channel.
export function toRGB(
  pix: Uint8Array, width: number, height: number, stride: number, mask: Uint8Array, r: number, bgra: boolean, bg: RGB,
  out?: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const dst = out?.length === width * height * 3 ? out : new Uint8Array(width * height * 3);
  const src = pix.byteOffset % 4 === 0 ? pix : new Uint8Array(pix);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2);
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2);
  const rowWords = stride >>> 2;
  const rgb = bgra ? (v: number) => ((v >>> 16) & 0xff) | (v & 0xff00) | ((v & 0xff) << 16) : (v: number) => v & 0xffffff;
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

// inCanvas draws img at (left, top) in an image of width by height,
// filling the rest with fill, or leaving it transparent for RGBA.
export function inCanvas(img: Image, width: number, height: number, left: number, top: number, fill: RGB | null): Image {
  const n = img.format / 8;
  const out = new Uint8Array(width * height * n);
  if (n === 3 && fill) for (let i = 0; i < out.length; i += 3) out.set(fill, i);
  const x0 = Math.max(0, left);
  const x1 = Math.min(width, left + img.width);
  if (x1 <= x0) return { pix: out, format: img.format, width, height };
  for (let y = Math.max(0, top); y < Math.min(height, top + img.height); y++) {
    const from = ((y - top) * img.width + (x0 - left)) * n;
    out.set(img.pix.subarray(from, from + (x1 - x0) * n), (y * width + x0) * n);
  }
  return { pix: out, format: img.format, width, height };
}

// thumbnail shrinks RGB or RGBA pixels, as format says, to at most
// maxHeight rows, averaging each block of pixels so text doesn't alias as
// it moves.
export function thumbnail(pix: Uint8Array, format: 24 | 32, width: number, height: number, maxHeight: number): Image {
  const step = Math.max(1, Math.ceil(height / maxHeight));
  const w = Math.trunc(width / step);
  const h = Math.trunc(height / step);
  const n = format / 8;
  const out = new Uint8Array(w * h * n);
  const area = step * step;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < n; c++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) {
          const row = ((y * step + dy) * width + x * step) * n + c;
          for (let dx = 0; dx < step; dx++) sum += pix[row + dx * n];
        }
        out[(y * w + x) * n + c] = sum / area;
      }
    }
  }
  return { pix: out, format, width: w, height: h };
}

// blur softens an image with a box blur of radius r pixels, across and then
// down, each pass a running sum along every line, clamped at its ends.
export function blur(img: Image, r: number): Image {
  if (r < 1) return img;
  const { width: w, height: h } = img;
  const n = img.format / 8;
  const div = 2 * r + 1;
  // pass blurs lines of len pixels, step apart within a line and lineStep
  // apart from one line to the next.
  const pass = (src: Uint8Array, lines: number, len: number, step: number, lineStep: number) => {
    const out = new Uint8Array(src.length);
    const last = (len - 1) * step;
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      for (let c = 0; c < n; c++) {
        const o = base + c;
        let sum = src[o] * (r + 1);
        for (let i = 1; i <= r; i++) sum += src[o + Math.min(i, len - 1) * step];
        for (let i = 0; i < len; i++) {
          out[o + i * step] = sum / div;
          sum += src[o + Math.min(last, (i + r + 1) * step)] - src[o + Math.max(0, i - r) * step];
        }
      }
    }
    return out;
  };
  const across = pass(img.pix, h, w, n, w * n);
  return { ...img, pix: pass(across, w, h, w * n, n) };
}

// roundedOutline draws an anti-aliased rounded rectangle outline in an RGBA
// image of w by h pixels. The rectangle's edges are at left, top, right and
// bottom, with corner radius r and line width stroke.
export function roundedOutline(
  w: number, h: number, left: number, top: number, right: number, bottom: number,
  r: number, stroke: number, color: [number, number, number],
): Uint8Array {
  const img = new Uint8Array(w * h * 4);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hx = (right - left) / 2 - r;
  const hy = (bottom - top) / 2 - r;
  const reach = stroke / 2 + 1;
  const plot = (x: number, y: number) => {
    const qx = Math.abs(x + 0.5 - cx) - hx;
    const qy = Math.abs(y + 0.5 - cy) - hy;
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    const a = Math.min(Math.max(stroke / 2 + 0.5 - Math.abs(sd), 0), 1);
    if (a > 0) {
      const i = (y * w + x) * 4;
      img[i] = color[0];
      img[i + 1] = color[1];
      img[i + 2] = color[2];
      img[i + 3] = a * 255;
    }
  };
  const band = (lo: number, hi: number, n: number) => [Math.max(0, Math.trunc(lo - reach)), Math.min(n, Math.ceil(hi + reach))];
  for (let y = 0; y < h; y++) {
    const fy = y + 0.5;
    if (fy < top + r + reach || fy > bottom - r - reach) {
      const [x0, x1] = band(left, right, w);
      for (let x = x0; x < x1; x++) plot(x, y);
      continue;
    }
    for (const edge of [left, right]) {
      const [x0, x1] = band(edge, edge, w);
      for (let x = x0; x < x1; x++) plot(x, y);
    }
  }
  return img;
}

// rgbOf reads the colour out of SGR parameters such as "38;2;10;132;255".
export function rgbOf(params: string): [number, number, number] {
  const parts = params.split(";");
  if (parts.length !== 5) return [0, 0, 0];
  return [Number(parts[2]) || 0, Number(parts[3]) || 0, Number(parts[4]) || 0];
}
