import { expect, test } from "bun:test";
import { cornerMask, toRGB } from "../src/view/frames";

test("toRGB drops alpha and swaps BGRA channels", () => {
  const rgb = toRGB(new Uint8Array([30, 20, 10, 0, 60, 50, 40, 0]), 2, 1, 8, new Uint8Array(0), 0, true, [0, 0, 0]);
  expect([...rgb]).toEqual([10, 20, 30, 40, 50, 60]);
});

test("toRGB fills the corners outside the radius with the background", () => {
  const w = 8, h = 8, r = 4;
  const pix = new Uint8Array(w * h * 4).fill(200);
  const rgb = toRGB(pix, w, h, w * 4, cornerMask(r), r, false, [10, 20, 30]);
  expect([...rgb.subarray(0, 3)]).toEqual([10, 20, 30]);
  const last = (w * h - 1) * 3;
  expect([...rgb.subarray(last, last + 3)]).toEqual([10, 20, 30]);
  const middle = ((h / 2) * w + w / 2) * 3;
  expect([...rgb.subarray(middle, middle + 3)]).toEqual([200, 200, 200]);
});

function referenceRGB(pix: Uint8Array, width: number, height: number, stride: number, bgra: boolean): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * 4;
      out.push(bgra ? pix[i + 2] : pix[i], pix[i + 1], bgra ? pix[i] : pix[i + 2]);
    }
  }
  return out;
}

test("toRGB packs any width and padded rows the same as byte by byte", () => {
  for (const width of [1, 2, 3, 4, 5, 6, 7, 9, 13]) {
    for (const height of [1, 2, 3, 5]) {
      for (const pad of [0, 4, 12]) {
        const stride = width * 4 + pad;
        const pix = new Uint8Array(stride * height).map((_, i) => (i * 37 + width) & 0xff);
        for (const bgra of [true, false]) {
          const got = toRGB(pix, width, height, stride, new Uint8Array(0), 0, bgra, [0, 0, 0]);
          expect([...got]).toEqual(referenceRGB(pix, width, height, stride, bgra));
        }
      }
    }
  }
});
