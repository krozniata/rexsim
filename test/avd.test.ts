import { expect, test } from "bun:test";
import { parseIni, rendersOnCPU, runtimeName, screenOf } from "../src/android/avd";
import { cornerMask, toRGB, toRGBA } from "../src/view/shapes";
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
