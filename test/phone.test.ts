import { expect, test } from "bun:test";
import type { Platform, Session } from "../src/device";
import { maxPixels } from "../src/ios/platform";
import { emptyBox } from "../src/view/layout";
import { Phone } from "../src/view/phone";

function phone(platform: Platform, width: number, height: number, drawnHeight: number): Phone {
  const p = new Phone({ id: "x", name: "x", runtime: "", booted: true, platform });
  const screen = { width, height, widthPoints: width / 3, heightPoints: height / 3 };
  const session = { screen, maxPixels: platform === "ios" ? maxPixels : undefined } as Session;
  p.state = { kind: "ready", session };
  p.box = { ...emptyBox, h: drawnHeight };
  return p;
}

test("a simulator streams at the drawn size while that fits 60 fps", () => {
  expect(phone("ios", 1206, 2622, 1334).wantScale()).toBe(0.55);
});

test("a simulator drawn large streams at most what fits 60 fps", () => {
  expect(phone("ios", 1206, 2622, 2622).wantScale()).toBe(0.6);
  expect(phone("ios", 1640, 2360, 1334).wantScale()).toBe(0.55);
});

test("an emulator streams at the size it is drawn, up to full size", () => {
  expect(phone("android", 1080, 2400, 600).wantScale()).toBe(0.25);
  expect(phone("android", 1080, 2400, 2400).wantScale()).toBe(1);
});

test("conversion alternates two buffers and never writes the one on screen", () => {
  const p = phone("android", 4, 8, 8);
  const frame = (v: number) => ({ width: 4, height: 8, stride: 16, channels: 4 as const, bgra: false, pix: new Uint8Array(4 * 8 * 4).fill(v) });
  const take = (v: number) => {
    (p as any).latest = frame(v);
    const f = p.takeLatest()!;
    p.current = f;
    return f;
  };
  const a = take(1);
  const b = take(2);
  expect(b.pix).not.toBe(a.pix);
  expect(a.pix[0]).toBe(1);
  const c = take(3);
  expect(c.pix).toBe(a.pix);
  expect(b.pix[0]).toBe(2);
});

test("an RGB frame with a known background has its corners filled in place", () => {
  const p = phone("android", 400, 800, 800);
  const pix = new Uint8Array(400 * 800 * 3).fill(200);
  (p as any).latest = { width: 400, height: 800, stride: 1200, channels: 3, bgra: false, pix };
  const f = p.takeLatest([10, 20, 30])!;
  expect(f.format).toBe(24);
  expect(f.pix).toBe(pix);
  expect([...pix.subarray(0, 3)]).toEqual([10, 20, 30]);
});
