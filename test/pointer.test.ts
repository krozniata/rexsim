import { expect, test } from "bun:test";
import type { Session } from "../src/device";
import type { App } from "../src/view/app";
import type { Mouse } from "../src/terminal/input";
import { Phone } from "../src/view/phone";
import { Pointer } from "../src/view/pointer";

type Call = string;

function setup(platform: "ios" | "android" = "android") {
  const calls: Call[] = [];
  const session = {
    screen: { width: 300, height: 600, widthPoints: 300, heightPoints: 600 },
    touch: async (x: number, y: number, down: boolean) => void calls.push(`touch ${x} ${y} ${down ? "down" : "up"}`),
  } as unknown as Session;
  const p = new Phone({ id: "x", name: "x", runtime: "", booted: true, platform });
  p.state = { kind: "ready", session };
  p.box = { col: 0, row: 0, cols: 30, rows: 60, x: 0, y: 0, w: 300, h: 600 };
  const a = { phones: [p], sidebar: null, events: { push: () => {} }, report: () => {}, setFocus: () => {} } as unknown as App;
  return { pointer: new Pointer(a), calls };
}

const wheel = (button: number, y = 300): Mouse => ({ kind: "mouse", button, x: 150, y, release: false, motion: false });
const click = (y: number): Mouse => ({ kind: "mouse", button: 0, x: 150, y, release: false, motion: false });

test("the wheel drags one finger that stays down while it turns", async () => {
  const { pointer, calls } = setup();
  await pointer.mouse(wheel(64));
  await pointer.mouse(wheel(64));
  await pointer.mouse(wheel(65));
  pointer.flushWheel();
  expect(calls).toEqual(["touch 150 300 down", "touch 150 330 down", "touch 150 360 down", "touch 150 330 down"]);
  await Bun.sleep(220);
  pointer.flushWheel();
  expect(calls.at(-1)).toBe("touch 150 330 up");
});

test("a finger that reaches the edge starts again from the far side", async () => {
  const { pointer, calls } = setup();
  await pointer.mouse(wheel(64, 560));
  await pointer.mouse(wheel(64));
  expect(calls).toEqual(["touch 150 560 down", "touch 150 590 down", "touch 150 590 up", "touch 150 120 down", "touch 150 150 down"]);
});

test("a click lifts the scrolling finger first", async () => {
  const { pointer, calls } = setup();
  await pointer.mouse(wheel(65));
  await pointer.mouse(click(100));
  expect(calls).toEqual(["touch 150 300 down", "touch 150 270 down", "touch 150 270 up", "touch 150 100 down"]);
});

test("a simulator scrolls with the same held finger", async () => {
  const { pointer, calls } = setup("ios");
  await pointer.mouse(wheel(64));
  await pointer.mouse(wheel(64));
  expect(calls).toEqual(["touch 150 300 down", "touch 150 330 down", "touch 150 360 down"]);
  pointer.stop();
});
