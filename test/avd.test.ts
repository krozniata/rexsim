import { expect, test } from "bun:test";
import { parseIni, rendersOnCPU, runtimeName, screenOf } from "../src/android/avd";
import { isSimlock } from "../src/device";

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

test("rendersOnCPU spots the software renderers", () => {
  expect(rendersOnCPU({ "hw.gpu.mode": "lavapipe" })).toBe(true);
  expect(rendersOnCPU({ "hw.gpu.mode": "swiftshader_indirect" })).toBe(true);
  expect(rendersOnCPU({ "hw.gpu.mode": "host" })).toBe(false);
  expect(rendersOnCPU({})).toBe(false);
});

test("isSimlock spots the devices Simlock manages", () => {
  expect(isSimlock("simlock-b87067bc-0616-4f24-b78d-f413b58de471")).toBe(true);
  expect(isSimlock("simlock_983c94c7-44eb-4b85-b43f-a9ee800ddea1")).toBe(true);
  expect(isSimlock("iPhone 17")).toBe(false);
  expect(isSimlock("Pixel_9_simlock")).toBe(false);
});
