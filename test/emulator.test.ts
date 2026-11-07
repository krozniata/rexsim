import { expect, test } from "bun:test";
import type { Client } from "../src/android/emulator";
import { Emulator } from "../src/android/platform";
import type { Frame } from "../src/device";

function emulator() {
  const touches: unknown[] = [];
  let onFrame: ((f: Frame, turns: number) => void) | undefined;
  const client = {
    send: async (_method: string, reqs: any[]) => void touches.push(...reqs.map((r) => [r.touches[0].x, r.touches[0].y])),
    stream: (_signal: AbortSignal, _side: number, f: (f: Frame, turns: number) => void) => {
      onFrame = f;
      return new Promise<Error>(() => {});
    },
  } as unknown as Client;
  const e = new Emulator(client, "Android 16", { width: 1080, height: 2400, widthPoints: 360, heightPoints: 800 });
  void e.stream(new AbortController().signal, 60, 1, () => {});
  const held = (turns: number) => onFrame!({ width: 1, height: 1, stride: 3, channels: 3, pix: new Uint8Array(3) }, turns);
  return { e, touches, held };
}

test("touches on a turned emulator land on its portrait panel", async () => {
  const { e, touches, held } = emulator();
  await e.touch(36, 160, true);
  held(3);
  await e.touch(80, 72, true);
  held(1);
  await e.touch(80, 72, true);
  held(2);
  await e.touch(36, 160, true);
  expect(touches).toEqual([[108, 480], [864, 240], [216, 2160], [972, 1920]]);
});
