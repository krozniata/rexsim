import { expect, test } from "bun:test";
import { blur, inCanvas, thumbnail } from "../src/view/shapes";

test("inCanvas draws an image at an offset and fills around it", () => {
  const img = { pix: new Uint8Array(2 * 2 * 3).fill(9), format: 24, width: 2, height: 2 };
  const out = inCanvas(img, 4, 3, 1, 1, [1, 2, 3]);
  expect([out.width, out.height]).toEqual([4, 3]);
  expect([...out.pix.subarray(0, 3)]).toEqual([1, 2, 3]);
  expect([...out.pix.subarray((1 * 4 + 1) * 3, (1 * 4 + 3) * 3)]).toEqual([9, 9, 9, 9, 9, 9]);
  expect([...out.pix.subarray((1 * 4 + 3) * 3, (1 * 4 + 4) * 3)]).toEqual([1, 2, 3]);
});

test("thumbnail averages the pixels it shrinks", () => {
  const pix = new Uint8Array([0, 0, 0, 200, 200, 200, 0, 0, 0, 200, 200, 200]);
  const img = thumbnail(pix, 2, 2, 1);
  expect([img.width, img.height]).toEqual([1, 1]);
  expect([...img.pix]).toEqual([100, 100, 100]);
});

test("blur spreads a bright pixel and keeps flat areas flat", () => {
  const pix = new Uint8Array(5 * 5 * 3).fill(50);
  pix.set([250, 250, 250], (2 * 5 + 2) * 3);
  const out = blur({ pix, format: 24, width: 5, height: 5 }, 1).pix;
  expect(out[(2 * 5 + 2) * 3]).toBeLessThan(250);
  expect(out[(2 * 5 + 3) * 3]).toBeGreaterThan(50);
  expect(out[0]).toBe(50);
});
