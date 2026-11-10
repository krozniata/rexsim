import { expect, test } from "bun:test";
import { newer } from "../src/upgrade";

test("newer compares dotted versions numerically", () => {
  expect(newer("0.2.0", "0.1.9")).toBe(true);
  expect(newer("0.10.0", "0.9.0")).toBe(true);
  expect(newer("v1.0", "0.9.9")).toBe(true);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("0.1.0", "0.1.1")).toBe(false);
  expect(newer("1.0", "1.0.0")).toBe(false);
});
