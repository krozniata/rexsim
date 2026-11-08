import type { Device, Platform } from "../device";

// Entry is a line of a device list: a platform's header, or the device at
// index i.
export type Entry = { kind: "header"; platform: Platform; count: number } | { kind: "device"; i: number };

export const platformName: Record<Platform, string> = { ios: "iOS", android: "Android" };

// groupEntries lists the devices under a header per platform, or plainly
// when they're all one platform. The devices must already be grouped by
// platform, so that moving through them by index follows the list.
export function groupEntries(devices: Device[]): Entry[] {
  const platforms = [...new Set(devices.map((d) => d.platform))];
  if (platforms.length < 2) return devices.map((_, i) => ({ kind: "device", i }));
  const out: Entry[] = [];
  for (const platform of platforms) {
    out.push({ kind: "header", platform, count: devices.filter((d) => d.platform === platform).length });
    devices.forEach((d, i) => {
      if (d.platform === platform) out.push({ kind: "device", i });
    });
  }
  return out;
}

export function entryOf(list: Entry[], i: number): number {
  return Math.max(0, list.findIndex((e) => e.kind === "device" && e.i === i));
}

// scrollTo returns the first entry to show so that entry k is among the
// visible ones. Scrolling up to the first device of a group brings its
// header along.
export function scrollTo(list: Entry[], k: number, offset: number, visible: number): number {
  if (k >= offset + visible) return k - visible + 1;
  if (k >= offset) return offset;
  let first = k;
  while (first > 0 && list[first - 1].kind !== "device") first--;
  return k - first < visible ? first : k;
}
