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
// simulator's framebuffer pads each row. A landscape frame has the screen's
// sides swapped. turn is how many quarter turns clockwise show it the way
// the device is held.
export type Frame = { width: number; height: number; stride: number; channels: 3 | 4; pix: Uint8Array; turn?: number };

// Orientation is which way up the device is held: landscapeLeft has the
// device's top on the left.
export type Orientation = "portrait" | "landscapeRight" | "portraitUpsideDown" | "landscapeLeft";

// clockwise lists the orientations a quarter turn clockwise apart, so an
// orientation's index is how many quarter turns it is from portrait.
export const clockwise: Orientation[] = ["portrait", "landscapeRight", "portraitUpsideDown", "landscapeLeft"];

// Session is a connected phone. Its methods take points on the screen as
// it shows upright, the way its frames are drawn.
export interface Session {
  readonly os: string;
  readonly screen: Screen;
  // maxPixels is the largest frame the stream can send at full rate, when
  // it has a limit.
  readonly maxPixels?: number;
  // warning says why the phone may stream poorly, such as an emulator that
  // renders on the CPU.
  readonly warning?: string;
  // top is the side of the screen, as it shows, that the device's top edge
  // is on, in quarter turns clockwise from the screen's top edge.
  readonly top: number;
  // stream sends a frame whenever the screen changes, however fast; fps is
  // how often the phone draws one, at most.
  stream(signal: AbortSignal, fps: number, scale: number, onFrame: (f: Frame) => void): Promise<Error>;
  touch(x: number, y: number, down: boolean): Promise<void>;
  // rotate turns the device a quarter clockwise.
  rotate(): Promise<void>;
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

// unturn maps a point on a picture turned turns quarters clockwise back
// onto the w by h picture it was turned from.
export function unturn(x: number, y: number, turns: number, w: number, h: number): [number, number] {
  switch (turns & 3) {
    case 1:
      return [y, h - x];
    case 2:
      return [w - x, h - y];
    case 3:
      return [w - y, x];
    default:
      return [x, y];
  }
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
