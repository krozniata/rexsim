import type { Platform } from "../device";
import type { Image } from "../kitty";

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
// returns a view.
export function toRGBA(
  pix: Uint8Array, width: number, height: number, stride: number, mask: Uint8Array, r: number, bgra = true,
): Uint8Array<ArrayBuffer> {
  const dst = new Uint8Array(width * height * 4);
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
  return dst;
}

// thumbnail shrinks RGBA pixels to at most maxHeight rows by sampling, which
// is enough while an image is moving.
export function thumbnail(rgba: Uint8Array, width: number, height: number, maxHeight: number): Image {
  const step = Math.max(1, Math.ceil(height / maxHeight));
  const w = Math.trunc(width / step);
  const h = Math.trunc(height / step);
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2);
  const pix = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pix[y * w + x] = src[y * step * width + x * step];
  }
  return { pix: new Uint8Array(pix.buffer), format: 32, width: w, height: h };
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
