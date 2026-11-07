import { expect, test } from "bun:test";
import type { Frame, Platform, Session } from "../src/device";
import { maxPixels } from "../src/ios/platform";
import { emptyBox } from "../src/view/layout";
import { Phone, type ViewFrame } from "../src/view/phone";

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

type Feed = (pix: Uint8Array, channels?: 3 | 4, turn?: number) => void;

// streaming gives a phone a fake session whose stream the test feeds frames
// into, as a device would.
function streaming(platform: Platform, width: number, height: number, fps: number): { p: Phone; feed: Feed } {
  let onFrame: ((f: Frame) => void) | undefined;
  const screen = { width, height, widthPoints: width / 3, heightPoints: height / 3 };
  const session = {
    screen,
    stream: (_signal: AbortSignal, _fps: number, _scale: number, f: (f: Frame) => void) => {
      onFrame = f;
      return new Promise<Error>(() => {});
    },
  } as unknown as Session;
  const p = new Phone({ id: "x", name: "x", runtime: "", booted: true, platform });
  p.state = { kind: "ready", session };
  p.startStream(new AbortController().signal, fps, () => {}, () => {});
  const feed: Feed = (pix, channels = 4, turn) => onFrame!({ width, height, stride: width * channels, channels, pix, turn });
  return { p, feed };
}

const bgra = (w: number, h: number, v: number) => new Uint8Array(w * h * 4).fill(v);
const middle = (pix: Uint8Array, w: number, h: number) => pix[((h >> 1) * w + (w >> 1)) * 3];

async function take(p: Phone): Promise<ViewFrame | null> {
  await p.frameDue(200);
  return p.takeLatest([10, 20, 30]);
}

test("a newer frame never overwrites the one on screen", async () => {
  const { p, feed } = streaming("ios", 40, 80, 60);
  feed(bgra(40, 80, 1));
  p.current = await take(p);
  for (const v of [2, 3, 4]) {
    const shown = p.current!;
    await Bun.sleep(20);
    feed(bgra(40, 80, v));
    const next = (await take(p))!;
    expect(middle(shown.pix, 40, 80)).toBe(v - 1);
    expect(middle(next.pix, 40, 80)).toBe(v);
    p.current = next;
  }
});

test("frames come out as RGB with their corners in the pane's colour", async () => {
  for (const channels of [3, 4] as const) {
    const { p, feed } = streaming("android", 400, 800, 60);
    feed(new Uint8Array(400 * 800 * channels).fill(200), channels);
    const f = (await take(p))!;
    expect(f.pix.length).toBe(400 * 800 * 3);
    expect([...f.pix.subarray(0, 3)]).toEqual([10, 20, 30]);
    expect(middle(f.pix, 400, 800)).toBe(200);
  }
});

test("a repeated frame isn't handed over again", async () => {
  const { p, feed } = streaming("ios", 40, 80, 60);
  feed(bgra(40, 80, 7));
  expect(await take(p)).not.toBeNull();
  await Bun.sleep(20);
  feed(bgra(40, 80, 7));
  expect(await take(p)).toBeNull();
});

test("a phone streaming at 10 fps hands over at most one frame per 100 ms, the newest", async () => {
  const { p, feed } = streaming("android", 40, 80, 10);
  const taken: number[] = [];
  const start = performance.now();
  for (let v = 1; v <= 30; v++) {
    feed(bgra(40, 80, v));
    const f = p.takeLatest([0, 0, 0]);
    if (f) taken.push(middle(f.pix, 40, 80));
    await Bun.sleep(10);
  }
  const f = await take(p);
  if (f) taken.push(middle(f.pix, 40, 80));
  const seconds = (performance.now() - start) / 1000;
  expect(taken.length).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 1);
  expect(taken.at(-1)).toBe(30);
});


test("a phone showing landscape takes touches and streams at its turned size", () => {
  const p = phone("ios", 1206, 2622, 301);
  p.current = { width: 1311, height: 603, pix: new Uint8Array(0) };
  expect(p.sideways).toBe(true);
  expect(p.points()).toEqual([874, 402]);
  expect(p.wantScale()).toBe(0.25);
});

test("a frame that only turned is handed over again, turned", async () => {
  const { p, feed } = streaming("ios", 40, 80, 60);
  feed(bgra(40, 80, 7));
  expect(await take(p)).not.toBeNull();
  await Bun.sleep(20);
  feed(bgra(40, 80, 7), 4, 3);
  expect(await take(p)).toMatchObject({ width: 80, height: 40 });
});
