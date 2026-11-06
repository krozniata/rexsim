// What the view uses of a phone, whether an iOS simulator behind
// idb_companion or an Android emulator over its own gRPC service.
import * as avd from "./avd";
import * as companion from "./companion";
import * as emulator from "./emulator";
import { Client as IdbClient } from "./idb";
import * as sim from "./sim";

export type Platform = "ios" | "android";

// Device is a simulator or an emulator. id is a simulator's UDID or an
// emulator's AVD name. serial is a running emulator's adb serial, such as
// emulator-5554, which test tools print.
export type Device = { id: string; name: string; runtime: string; booted: boolean; platform: Platform; serial?: string };

// Screen is the size in pixels and in points, the unit touches use. An
// Android point is a density-independent pixel.
export type Screen = { width: number; height: number; widthPoints: number; heightPoints: number };

// Frame holds 4-byte pixels, BGRA from a simulator and RGBA from an
// emulator. Rows are stride bytes apart, because a simulator's framebuffer
// pads each row.
export type Frame = { width: number; height: number; stride: number; bgra: boolean; pix: Uint8Array };

export type Button = "HOME" | "LOCK";

// Session is a connected phone. Its methods take points.
export interface Session {
  readonly os: string;
  readonly screen: Screen;
  stream(signal: AbortSignal, fps: number, scale: number, onFrame: (f: Frame) => void): Promise<Error>;
  touch(x: number, y: number, down: boolean): Promise<void>;
  button(b: Button): Promise<void>;
  key(code: number, shift: boolean): Promise<void>;
  text(s: string): Promise<void>;
  swipe(x0: number, y0: number, x1: number, y1: number, seconds: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export function label(d: Device): string {
  return `${d.name} · ${d.runtime}`;
}

// find looks a device up by its UDID, AVD name or adb serial, or else by its
// name, which several simulators can share across runtimes; a booted one
// wins, then the newest.
export function find(devices: Device[], key: string): Device | undefined {
  const byId = devices.find((d) => d.id === key || d.serial === key);
  if (byId) return byId;
  const named = devices.filter((d) => d.name.toLowerCase() === key.toLowerCase());
  return named.find((d) => d.booted) ?? named[0];
}

// devices lists the simulators and then the emulators, booted ones first in
// each. Without Xcode it lists only the emulators, and the other way round.
export async function devices(signal: AbortSignal): Promise<Device[]> {
  const [ios, android] = await Promise.allSettled([sim.devices(signal), avd.devices()]);
  if (ios.status === "rejected" && android.status === "rejected") throw ios.reason;
  if (ios.status === "rejected" && android.status === "fulfilled" && android.value.length === 0) throw ios.reason;
  return [...(ios.status === "fulfilled" ? ios.value : []), ...(android.status === "fulfilled" ? android.value : [])];
}

// companionBin is only called for a simulator.
export function connect(signal: AbortSignal, d: Device, companionBin: () => Promise<string>): Promise<Session> {
  return d.platform === "ios" ? connectSimulator(signal, d, companionBin) : connectEmulator(signal, d);
}

export function shutdown(d: Device): void {
  if (d.platform === "ios") sim.shutdown(d.id);
  else void avd.shutdown(d.id).catch(() => {});
}

async function connectSimulator(signal: AbortSignal, d: Device, companionBin: () => Promise<string>): Promise<Session> {
  const bin = await companionBin();
  if (!d.booted) await sim.boot(signal, d.id);
  const comp = await companion.start(signal, bin, d.id);
  const client = new IdbClient(comp.socket);
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
      stream: (signal, fps, scale, onFrame) => client.stream(signal, fps, scale, screen, onFrame),
      touch: (x, y, down) => client.touch(x, y, down),
      button: (b) => client.button(b),
      key: (code, shift) => client.key(code, shift),
      text: (s) => client.text(s),
      swipe: (x0, y0, x1, y1, seconds) => client.swipe(x0, y0, x1, y1, seconds),
      screenshot: () => client.screenshot(),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function connectEmulator(signal: AbortSignal, d: Device): Promise<Session> {
  const e = avd.running(d.id) ?? (await avd.boot(signal, d.id));
  const client = new emulator.Client(e.port, e.token);
  try {
    const hw = await client.waitBooted(signal);
    return new emulator.Emulator(client, d.runtime, avd.screenOf(hw));
  } catch (err) {
    client.close();
    throw err;
  }
}
