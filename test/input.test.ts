import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { parse, readEvents } from "../src/terminal/input";

const key = (rune: string, name = "") => ({ kind: "key", rune, name });
const mouse = (button: number, x: number, y: number, release = false, motion = false) => ({ kind: "mouse", button, x, y, release, motion });

test.each([
  ["\x1b[<0;650;300M", mouse(0, 649, 299), 13],
  ["\x1b[<32;700;300M", mouse(0, 699, 299, false, true), 14],
  ["\x1b[<0;700;300m", mouse(0, 699, 299, true), 13],
  ["\x1b[<65;10;20M", mouse(65, 9, 19), 12],
  ["\x1b[200~hi there\x1b[201~", { kind: "paste", text: "hi there" }, 20],
  ["\x1b[A", key("", "up"), 3],
  ["\x02", key("", "ctrl+b"), 1],
  ["\x1d", key("", "ctrl+]"), 1],
  ["\r", key("", "enter"), 1],
  ["ż", key("ż"), 2],
  ["\x1b]11;rgb:1e1e/1e1e/2020\x1b\\", { kind: "osc", text: "11;rgb:1e1e/1e1e/2020" }, 25],
  ["\x1b]11;rgb:ffff/ffff/ffff\x07", { kind: "osc", text: "11;rgb:ffff/ffff/ffff" }, 24],
  ["\x1b]11;rgb:ff", null, 0],
  ["\x1b", null, 0],
  ["\x1b[<0;65", null, 0],
  ["\x1b[200~unfinished", null, 0],
] as const)("parse(%j)", (input, want, n) => {
  expect(parse(Buffer.from(input))).toEqual([want as any, n]);
});

describe("readEvents", () => {
  const setup = () => {
    const input = new EventEmitter();
    const got: unknown[] = [];
    readEvents(input as any, (ev) => got.push(ev));
    return { send: (s: string) => input.emit("data", Buffer.from(s)), got };
  };

  test("a lone escape becomes esc", async () => {
    const { send, got } = setup();
    send("\x1b");
    await Bun.sleep(60);
    expect(got).toEqual([key("", "esc")]);
  });

  test("a mouse report split across slow reads stays one report", async () => {
    const { send, got } = setup();
    send("\x1b[<0;6");
    await Bun.sleep(80);
    send("50;300M");
    expect(got).toEqual([mouse(0, 649, 299)]);
  });

  test("an escape split from its sequence survives a busy event loop", async () => {
    const child = spawn("sh", ["-c", "printf '\\033'; sleep 0.02; printf '[<0;650;300M'"]);
    const got: unknown[] = [];
    readEvents(child.stdout as any, (ev) => got.push(ev));
    child.stdout.once("data", () => Bun.sleepSync(120));
    await new Promise((resolve) => child.on("close", resolve));
    await Bun.sleep(50);
    expect(got).toEqual([mouse(0, 649, 299)]);
  });

  test("an unfinished sequence is dropped, not typed", async () => {
    const { send, got } = setup();
    send("\x1b[<0;6");
    await Bun.sleep(1100);
    send("x");
    expect(got).toEqual([key("x")]);
  });
});
