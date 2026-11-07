import { android } from "./android/platform";
import type { Device, Platform, Provider, Session } from "./device";
import { ios } from "./ios/platform";

// Simulators are listed before emulators.
const providers: Record<Platform, Provider> = { ios, android };

// devices lists every platform's devices, booted ones first in each. A
// platform that fails, such as iOS without Xcode, is left out, unless no
// other has any devices.
export async function devices(signal: AbortSignal): Promise<Device[]> {
  const results = await Promise.allSettled(Object.values(providers).map((p) => p.devices(signal)));
  const found = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.find((r) => r.status === "rejected");
  if (found.length === 0 && failed) throw failed.reason;
  return found;
}

export function connect(signal: AbortSignal, d: Device, progress: (text: string) => void): Promise<Session> {
  return providers[d.platform].connect(signal, d, progress);
}

export function shutdown(d: Device): void {
  providers[d.platform].shutdown(d);
}
