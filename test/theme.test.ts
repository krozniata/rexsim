import { expect, test } from "bun:test";
import { colorOf } from "../src/view/theme";

test("colorOf reads OSC colour replies of any channel width", () => {
  expect(colorOf("rgb:1e1e/1e1e/2020")).toEqual([30, 30, 32]);
  expect(colorOf("rgb:f/0/8")).toEqual([255, 0, 136]);
  expect(colorOf("#1e1e20")).toBeNull();
});
