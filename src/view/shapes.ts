// Draws the images around and between frames: a phone's border, and the
// copies that move while the layout animates.
import type { Image } from "../terminal/kitty";
import type { RGB } from "./theme";

// inCanvas draws the RGB image img at (left, top) in one of width by
// height, filling the rest with fill.
export function inCanvas(img: Image, width: number, height: number, left: number, top: number, fill: RGB): Image {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < out.length; i += 3) out.set(fill, i);
  const x0 = Math.max(0, left);
  const x1 = Math.min(width, left + img.width);
  if (x1 > x0) {
    for (let y = Math.max(0, top); y < Math.min(height, top + img.height); y++) {
      const from = ((y - top) * img.width + (x0 - left)) * 3;
      out.set(img.pix.subarray(from, from + (x1 - x0) * 3), (y * width + x0) * 3);
    }
  }
  return { pix: out, format: 24, width, height };
}

// thumbnail shrinks RGB pixels to at most maxHeight rows, averaging each
// block of pixels so text doesn't alias as it moves.
export function thumbnail(pix: Uint8Array, width: number, height: number, maxHeight: number): Image {
  const step = Math.max(1, Math.ceil(height / maxHeight));
  const w = Math.trunc(width / step);
  const h = Math.trunc(height / step);
  const out = new Uint8Array(w * h * 3);
  const area = step * step;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) {
          const row = ((y * step + dy) * width + x * step) * 3 + c;
          for (let dx = 0; dx < step; dx++) sum += pix[row + dx * 3];
        }
        out[(y * w + x) * 3 + c] = sum / area;
      }
    }
  }
  return { pix: out, format: 24, width: w, height: h };
}

// blur softens an RGB image with a box blur of radius r pixels, across and
// then down, each pass a running sum along every line, clamped at its ends.
export function blur(img: Image, r: number): Image {
  if (r < 1) return img;
  const { width: w, height: h } = img;
  const n = 3;
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
