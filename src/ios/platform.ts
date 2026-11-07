// iOS simulators, which idb_companion streams and drives.
import type { Device, Provider, Session } from "../device";
import * as companion from "./companion";
import { Client } from "./idb";
import * as simctl from "./simctl";

// maxPixels is about what idb_companion can send at 60 fps, some 320 MB/s of
// raw pixels.
export const maxPixels = 1_300_000;

export const ios: Provider = {
  devices: simctl.devices,
  connect,
  shutdown: (d) => simctl.shutdown(d.id),
};

async function connect(signal: AbortSignal, d: Device, progress: (text: string) => void): Promise<Session> {
  const bin = await companion.binary(progress);
  if (!d.booted) await simctl.boot(signal, d.id);
  const comp = await companion.start(signal, bin, d.id);
  const client = new Client(comp.socket);
  const close = async () => {
    client.close();
    await comp.close();
  };
  try {
    const desc = await client.describe(signal);
    const screen = desc.screen;
    return {
      os: "iOS " + desc.osVersion.replace(/^iOS/, "").trim(),
      screen,
      maxPixels,
      stream: (signal, fps, scale, onFrame) => client.stream(signal, fps, scale, screen, onFrame),
      touch: (x, y, down) => client.touch(x, y, down),
      home: () => client.home(),
      key: (code, shift) => client.key(code, shift),
      text: (s) => client.text(s),
      screenshot: () => client.screenshot(),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
