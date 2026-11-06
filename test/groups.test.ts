import { expect, test } from "bun:test";
import type { Device, Platform } from "../src/device";
import { groupEntries, scrollTo } from "../src/view/groups";

const dev = (platform: Platform): Device => ({ id: "", name: "", runtime: "", booted: false, platform });

test("one platform gets no headers", () => {
  expect(groupEntries([dev("ios"), dev("ios")], true)).toEqual([{ kind: "device", i: 0 }, { kind: "device", i: 1 }]);
});

test("two platforms each get a header, with a gap before the second", () => {
  expect(groupEntries([dev("ios"), dev("android"), dev("android")], true)).toEqual([
    { kind: "header", platform: "ios", count: 1 },
    { kind: "device", i: 0 },
    { kind: "gap" },
    { kind: "header", platform: "android", count: 2 },
    { kind: "device", i: 1 },
    { kind: "device", i: 2 },
  ]);
});

test("scrolling up to a group's first device shows its header", () => {
  const list = groupEntries([dev("ios"), dev("ios"), dev("android"), dev("android")], true);
  expect(scrollTo(list, 5, 6, 3)).toBe(3);
  expect(scrollTo(list, 5, 0, 3)).toBe(3);
  expect(scrollTo(list, 6, 0, 3)).toBe(4);
  expect(scrollTo(list, 1, 0, 3)).toBe(0);
});
