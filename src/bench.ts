// Times the per-frame work: dropping repeated frames, converting to RGB and
// writing the file that the terminal reads.
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cornerMask, screenRadius, toRGB } from "./view/frames";

function time(name: string, fn: () => void): void {
  for (let i = 0; i < 20; i++) fn();
  let n = 0;
  const start = performance.now();
  while (performance.now() - start < 1000) {
    fn();
    n++;
  }
  console.log(`${name.padEnd(30)} ${(((performance.now() - start) / n) * 1000).toFixed(0).padStart(8)} µs/op`);
}

function bench(label: string, w: number, h: number): void {
  const stride = Math.ceil((w * 4) / 64) * 64;
  const aligned = new Uint8Array(stride * h);
  const misaligned = Buffer.alloc(stride * h + 3).subarray(3);
  const r = Math.trunc(screenRadius(w / h) * w);
  const mask = cornerMask(r);
  const out = new Uint8Array(w * h * 3);
  time(`${label}/hash`, () => Bun.hash(aligned));
  time(`${label}/toRGB`, () => toRGB(aligned, w, h, stride, mask, r, true, [0, 0, 0], out));
  time(`${label}/toRGB-misaligned`, () => toRGB(misaligned, w, h, stride, mask, r, true, [0, 0, 0], out));
  const path = join(tmpdir(), "rexsim-bench");
  time(`${label}/tempfile`, () => {
    writeFileSync(path, out);
    unlinkSync(path);
  });
}

bench("FrameHalf", 603, 1311);
bench("FrameFull", 1206, 2622);
