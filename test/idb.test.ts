import { expect, test } from "bun:test";
import { frameSize } from "../src/ios/idb";

const iphone18Pro = { width: 1206, height: 2622, widthPoints: 402, heightPoints: 874 };

test.each([
  ["half scale pads rows to 64 bytes", 3188352, 0.5, 603, 1311, 2432],
  ["full scale adds two rows", 12763136, 1, 1206, 2622, 4864],
  ["a landscape frame swaps the sides", 789824, 0.25, 656, 301, 2624],
])("frameSize: %s", (_, n, scale, width, height, stride) => {
  expect(frameSize(n, iphone18Pro, scale)).toEqual({ width, height, stride });
});
