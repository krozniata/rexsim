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

test("an emulator drawn large streams at full size", () => {
  expect(phone("android", 1080, 2400, 2400).wantScale()).toBe(1);
});
