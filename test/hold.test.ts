import { expect, test } from "bun:test";
import { Hold } from "../src/ios/platform";

const iphone = { width: 1206, height: 2622, widthPoints: 402, heightPoints: 874 };

test("an app that turns with the device needs no turning", () => {
  const h = new Hold(iphone, false);
  h.set("landscapeLeft");
  h.sideways = true;
  expect([h.top, h.turn]).toEqual([3, 0]);
  expect(h.unturn(100, 50)).toEqual([100, 50]);
});

test("a portrait-only app turns with the device, and touches turn back", () => {
  const h = new Hold(iphone, false);
  h.set("landscapeLeft");
  expect([h.top, h.turn]).toEqual([3, 3]);
  // Near the left edge, where the device's top is, halfway down.
  expect(h.unturn(87, 201)).toEqual([201, 87]);
});

test("an iPhone held upside down shows its app upside down", () => {
  const h = new Hold(iphone, false);
  h.set("portraitUpsideDown");
  expect([h.top, h.turn]).toEqual([2, 2]);
  expect(h.unturn(2, 4)).toEqual([400, 870]);
});

test("an iPad's app turns over with it", () => {
  const h = new Hold(iphone, true);
  h.set("portraitUpsideDown");
  expect(h.turn).toBe(0);
});

test("a landscape app on an upright device keeps the way it last turned", () => {
  const h = new Hold(iphone, false);
  h.sideways = true;
  expect(h.turn).toBe(3);
  h.set("landscapeLeft");
  h.set("portrait");
  expect(h.turn).toBe(1);
});
