// Lists, boots and shuts down Android emulators from the AVDs that Android
// Studio makes.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cacheDir } from "./companion";
import type { Device, Screen } from "./device";
import { Client } from "./emulator";

// Running is an emulator's gRPC endpoint, from its discovery file.
export type Running = { id: string; pid: number; port: number; token: string };

export function sdkRoot(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), "Library", "Android", "sdk");
}

function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME;
  return join(process.env.ANDROID_USER_HOME || join(homedir(), ".android"), "avd");
}

// discoveryDir is where each running emulator writes pid_<pid>.ini, readable
// only by its user, with its gRPC port and the token that the port demands.
function discoveryDir(): string {
  return join(homedir(), "Library", "Caches", "TemporaryItems", "avd", "running");
}

export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function readIni(path: string): Record<string, string> | null {
  try {
    return parseIni(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// devices lists the AVDs, booted ones first and newer Android versions
// before older ones. Without an AVD directory there are none.
export async function devices(): Promise<Device[]> {
  const home = avdHome();
  let files: string[];
  try {
    files = readdirSync(home).filter((f) => f.endsWith(".ini"));
  } catch {
    return [];
  }
  const booted = new Set(runningAll().map((r) => r.id));
  const found: { d: Device; api: number }[] = [];
  for (const file of files) {
    const id = file.slice(0, -".ini".length);
    const ini = readIni(join(home, file));
    if (!ini) continue;
    const config = readIni(join(ini.path || join(home, `${id}.avd`), "config.ini")) ?? {};
    const api = apiLevel(ini.target) || apiLevel(config["image.sysdir.1"]);
    const name = config["avd.ini.displayname"] || id.replaceAll("_", " ");
    found.push({ d: { id, name, runtime: runtimeName(api), booted: booted.has(id), platform: "android" }, api });
  }
  found.sort((a, b) => {
    if (a.d.booted !== b.d.booted) return a.d.booted ? -1 : 1;
    if (a.api !== b.api) return b.api - a.api;
    return a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0;
  });
  return found.map((f) => f.d);
}

// apiLevel reads the level out of android-36 or system-images/android-36/…,
// and gives 0 for a preview's or an add-on's name.
function apiLevel(s: string | undefined): number {
  return Number(/android-(\d+)/.exec(s ?? "")?.[1]) || 0;
}

const versions: Record<number, string> = {
  28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
};

export function runtimeName(api: number): string {
  if (!api) return "Android";
  return versions[api] ? `Android ${versions[api]}` : `Android API ${api}`;
}

// screenOf reads the screen's size from the emulator's hardware config.
// Points are density-independent pixels, 160 to the inch.
export function screenOf(hw: Record<string, string>): Screen {
  const width = Number(hw["hw.lcd.width"]);
  const height = Number(hw["hw.lcd.height"]);
  const density = Number(hw["hw.lcd.density"]) || 160;
  if (!width || !height) throw new Error("the emulator reported no screen size");
  return { width, height, widthPoints: (width * 160) / density, heightPoints: (height * 160) / density };
}

// runningAll lists the emulators that serve gRPC. A crashed emulator leaves
// its discovery file behind, so the process must still exist.
function runningAll(): Running[] {
  const dir = discoveryDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const result: Running[] = [];
  for (const file of files) {
    const pid = Number(/^pid_(\d+)\.ini$/.exec(file)?.[1]);
    if (!pid || !alive(pid)) continue;
    const ini = readIni(join(dir, file));
    const port = Number(ini?.["grpc.port"]);
    const id = ini?.["avd.id"] || ini?.["avd.name"];
    if (!ini || !port || !id) continue;
    result.push({ id, pid, port, token: ini["grpc.token"] ?? "" });
  }
  return result;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function running(id: string): Running | null {
  return runningAll().find((r) => r.id === id) ?? null;
}

// boot starts an emulator without a window, since rexsim draws its screen,
// and waits for its gRPC service to come up. The emulator runs in its own
// session, so it keeps running when rexsim's pane closes, as a simulator
// does. One given up on before then is stopped, because without its gRPC
// service nothing could shut down an emulator that has no window.
export async function boot(signal: AbortSignal, id: string): Promise<Running> {
  const bin = join(sdkRoot(), "emulator", "emulator");
  if (!existsSync(bin)) throw new Error(`no Android emulator at ${bin}; set ANDROID_HOME to the SDK`);
  const root = cacheDir();
  mkdirSync(root, { recursive: true });
  const logPath = join(root, `emulator-${id}.log`);
  const log = openSync(logPath, "w", 0o600);
  let failed = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, ["-avd", id, "-no-window", "-no-audio", "-no-boot-anim"], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.on("error", () => (failed = true));
    child.on("exit", (code) => (failed ||= code !== 0));
    child.unref();
  } finally {
    closeSync(log);
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = running(id);
    if (r) return r;
    if (signal.aborted || Date.now() > deadline) stop(child);
    if (signal.aborted) throw signal.reason;
    if (failed) throw new Error(`the emulator exited; see ${logPath}`);
    if (Date.now() > deadline) throw new Error(`the emulator did not start; see ${logPath}`);
    await Bun.sleep(200);
  }
}

// stop signals the launcher's whole process group, since the launcher runs
// the emulator as a child of its own.
function stop(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {}
}

// shutdown asks an emulator to shut down the way closing its window does.
export async function shutdown(id: string): Promise<void> {
  const r = running(id);
  if (!r) return;
  const c = new Client(r.port, r.token);
  try {
    await c.setVmState("SHUTDOWN");
  } finally {
    c.close();
  }
}
