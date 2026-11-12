// Lists and boots simulators with simctl.
import { compareDevices, type Device, isSimlock } from "../device";
import { run } from "../exec";

// devices lists the available iOS simulators, booted ones first and newer
// runtimes before older ones.
export async function devices(signal: AbortSignal): Promise<Device[]> {
  const { code, out } = await run(["xcrun", "simctl", "list", "devices", "available", "--json"], signal);
  if (code !== 0) throw new Error(`simctl list: ${out}`);
  const list: { devices: Record<string, { udid: string; name: string; state: string }[]> } = JSON.parse(out);
  const result: Device[] = [];
  for (const [runtime, ds] of Object.entries(list.devices)) {
    const name = runtimeName(runtime);
    if (!name) continue;
    for (const d of ds) {
      const booted = d.state === "Booted";
      const managed = isSimlock(d.name);
      // A managed simulator that is not booted is Simlock's spare: leave it be.
      if (managed && !booted) continue;
      result.push({ id: d.udid, name: d.name, runtime: name, booted, platform: "ios", ...(managed && { managed }) });
    }
  }
  return result.sort((a, b) => compareDevices(a, b, a.runtime === b.runtime ? 0 : versionLess(b.runtime, a.runtime) ? -1 : 1));
}

// runtimeName turns com.apple.CoreSimulator.SimRuntime.iOS-27-0 into iOS 27.0.
function runtimeName(id: string): string | null {
  const prefix = "com.apple.CoreSimulator.SimRuntime.iOS-";
  return id.startsWith(prefix) ? "iOS " + id.slice(prefix.length).replaceAll("-", ".") : null;
}

function versionLess(a: string, b: string): boolean {
  const pa = a.replace(/^iOS /, "").split(".");
  const pb = b.replace(/^iOS /, "").split(".");
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const x = parseInt(pa[i]) || 0;
    const y = parseInt(pb[i]) || 0;
    if (x !== y) return x < y;
  }
  return pa.length < pb.length;
}

// boot starts a simulator and waits until it has finished booting. It
// doesn't open Simulator.app; rexsim reads the framebuffer directly.
export async function boot(signal: AbortSignal, udid: string): Promise<void> {
  const { code, out } = await run(["xcrun", "simctl", "bootstatus", udid, "-b"], signal);
  if (code !== 0) throw new Error(`boot: ${out}`);
}

export function shutdown(udid: string): void {
  try {
    Bun.spawn(["xcrun", "simctl", "shutdown", udid], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
