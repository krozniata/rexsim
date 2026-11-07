import { expect, test } from "bun:test";
import { parseIni, rendersOnCPU, runtimeName, screenOf } from "../src/android/avd";
import { blur, cornerMask, inCanvas, thumbnail, toRGB, toRGBA } from "../src/view/shapes";
import { colorOf } from "../src/view/theme";

test("parseIni keeps everything after the first =", () => {
  expect(parseIni("avd.id=Bench_Phone\ngrpc.token=a=b\n\nnot a pair\n")).toEqual({ "avd.id": "Bench_Phone", "grpc.token": "a=b" });
});

test.each([
  [36, "Android 16"],
  [32, "Android 12L"],
  [99, "Android API 99"],
  [0, "Android"],
])("runtimeName(%d)", (api, name) => {
  expect(runtimeName(api)).toBe(name);
});

test("screenOf measures points in density-independent pixels", () => {
  expect(screenOf({ "hw.lcd.width": "1080", "hw.lcd.height": "2400", "hw.lcd.density": "480" })).toEqual({
    width: 1080, height: 2400, widthPoints: 360, heightPoints: 800,
  });
});

test("toRGBA keeps RGBA channels in place", () => {
  const rgba = toRGBA(new Uint8Array([10, 20, 30, 0, 40, 50, 60, 0]), 2, 1, 8, new Uint8Array(0), 0, false);
  expect([...rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
});

test("toRGBA swaps BGRA channels", () => {
  const rgba = toRGBA(new Uint8Array([30, 20, 10, 0]), 1, 1, 4, new Uint8Array(0), 0);
  expect([...rgba]).toEqual([10, 20, 30, 255]);
});

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

test("colorOf reads OSC colour replies of any channel width", () => {
  expect(colorOf("rgb:1e1e/1e1e/2020")).toEqual([30, 30, 32]);
  expect(colorOf("rgb:f/0/8")).toEqual([255, 0, 136]);
  expect(colorOf("#1e1e20")).toBeNull();
});

test("rendersOnCPU spots the software renderers", () => {
  expect(rendersOnCPU({ "hw.gpu.mode": "lavapipe" })).toBe(true);
  expect(rendersOnCPU({ "hw.gpu.mode": "swiftshader_indirect" })).toBe(true);
  expect(rendersOnCPU({ "hw.gpu.mode": "host" })).toBe(false);
  expect(rendersOnCPU({})).toBe(false);
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
  const img = thumbnail(pix, 24, 2, 2, 1);
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
