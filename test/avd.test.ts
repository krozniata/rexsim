import { expect, test } from "bun:test";
import { parseIni, runtimeName, screenOf } from "../src/avd";
import { toRGBA } from "../src/view/shapes";

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
