// What the view uses of a phone, whether an iOS simulator behind
// idb_companion or an Android emulator over its own gRPC service.

export type Platform = "ios" | "android";

// Device is a simulator or an emulator. id is a simulator's UDID or an
// emulator's AVD name. serial is a running emulator's adb serial, such as
// emulator-5554, which test tools print.
export type Device = { id: string; name: string; runtime: string; booted: boolean; platform: Platform; serial?: string };

// Screen is the size in pixels and in points, the unit touches use. An
// Android point is a density-independent pixel.
export type Screen = { width: number; height: number; widthPoints: number; heightPoints: number };

// Frame holds BGRA pixels from a simulator, or packed RGB ones, 3 bytes
// each, from an emulator. Rows are stride bytes apart, because a
// simulator's framebuffer pads each row.
export type Frame = { width: number; height: number; stride: number; channels: 3 | 4; pix: Uint8Array };

// Session is a connected phone. Its methods take points.
export interface Session {
  readonly os: string;
  readonly screen: Screen;
  // maxPixels is the largest frame the stream can send at full rate, when
  // it has a limit.
  readonly maxPixels?: number;
  // warning says why the phone may stream poorly, such as an emulator that
  // renders on the CPU.
  readonly warning?: string;
  // stream asks for fps frames a second, which an emulator ignores: it
  // sends one whenever the screen changes.
  stream(signal: AbortSignal, fps: number, scale: number, onFrame: (f: Frame) => void): Promise<Error>;
  touch(x: number, y: number, down: boolean): Promise<void>;
  home(): Promise<void>;
  key(code: number, shift: boolean): Promise<void>;
  text(s: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

// Provider lists, connects and shuts down one platform's devices.
export interface Provider {
  devices(signal: AbortSignal): Promise<Device[]>;
  // connect boots the device if needed. progress reports a slow first step,
  // such as a download.
  connect(signal: AbortSignal, d: Device, progress: (text: string) => void): Promise<Session>;
  shutdown(d: Device): void;
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

// resolve finds the devices that keys name, once each, or every booted one
// when keys is empty.
export function resolve(devices: Device[], keys: string[]): Device[] {
  const unknown = keys.filter((k) => !find(devices, k));
  if (unknown.length > 0) throw new Error(`no simulator or emulator is called ${unknown.join(", ")}`);
  const found = keys.length > 0 ? [...new Set(keys.map((k) => find(devices, k)!))] : devices.filter((d) => d.booted);
  if (found.length === 0) throw new Error("no simulator or emulator is booted; name the ones to show");
  return found;
}

// compareDevices orders booted devices first, then by newer, which is
// negative when a's version is newer than b's, then by name.
export function compareDevices(a: Device, b: Device, newer: number): number {
  if (a.booted !== b.booted) return a.booted ? -1 : 1;
  if (newer !== 0) return newer;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
