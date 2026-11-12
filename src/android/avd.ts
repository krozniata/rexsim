// Lists, boots and shuts down Android emulators from the AVDs that Android
// Studio makes.
import { spawn } from "node:child_process";
import { closeSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareDevices, type Device, isSimlock, type Screen } from "../device";
import { Client } from "./emulator";
import { openLog, poll } from "../exec";

// Running is an emulator's gRPC endpoint, from its discovery file. dir is its
// AVD's directory, which may be outside the AVD home, as Simlock's are.
export type Running = { id: string; pid: number; port: number; token: string; serial: string; dir: string };

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
// before older ones. Running emulators whose AVDs live outside the AVD home,
// such as Simlock's, are listed too, as managed when Simlock made them.
export async function devices(): Promise<Device[]> {
  const home = avdHome();
  let files: string[];
  try {
    files = readdirSync(home).filter((f) => f.endsWith(".ini"));
  } catch {
    files = [];
  }
  const running = runningAll();
  const serials = new Map(running.map((r) => [r.id, r.serial]));
  const found: { d: Device; api: number }[] = [];
  const add = (id: string, target: string | undefined, dir: string, booted: boolean) => {
    const config = readIni(join(dir, "config.ini")) ?? {};
    const api = apiLevel(target) || apiLevel(config["image.sysdir.1"]);
    const managed = isSimlock(id);
    const name = managed ? `simlock ${id.slice("simlock_".length)}` : config["avd.ini.displayname"] || id.replaceAll("_", " ");
    const d: Device = { id, name, runtime: runtimeName(api), booted, platform: "android" };
    if (serials.get(id)) d.serial = serials.get(id);
    if (managed) d.managed = true;
    found.push({ d, api });
  };
  const listed = new Set<string>();
  for (const file of files) {
    const id = file.slice(0, -".ini".length);
    const ini = readIni(join(home, file));
    if (!ini) continue;
    listed.add(id);
    add(id, ini.target, ini.path || join(home, `${id}.avd`), serials.has(id));
  }
  for (const r of running) {
    if (listed.has(r.id) || !r.dir) continue;
    listed.add(r.id);
    add(r.id, undefined, r.dir, true);
  }
  found.sort((a, b) => compareDevices(a.d, b.d, b.api - a.api));
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

// rendersOnCPU reports whether an emulator draws with a software renderer,
// as one started without a window by something other than rexsim does.
export function rendersOnCPU(hw: Record<string, string>): boolean {
  return /swiftshader|lavapipe|guest/.test(hw["hw.gpu.mode"] ?? "");
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
    const consolePort = Number(ini["port.serial"]);
    const serial = consolePort ? `emulator-${consolePort}` : "";
    result.push({ id, pid, port, token: ini["grpc.token"] ?? "", serial, dir: ini["avd.dir"] ?? "" });
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
// and waits for its gRPC service to come up. Without a window the default
// GPU mode falls back to rendering on the CPU, which takes several cores
// and stutters, so it asks for the host's GPU. The emulator runs in its own
// session, so it keeps running when rexsim's pane closes, as a simulator
// does. One given up on before then is stopped, because without its gRPC
// service nothing could shut down an emulator that has no window.
export async function boot(signal: AbortSignal, id: string): Promise<Running> {
  const bin = join(sdkRoot(), "emulator", "emulator");
  if (!existsSync(bin)) throw new Error(`no Android emulator at ${bin}; set ANDROID_HOME to the SDK`);
  const log = openLog(`emulator-${id}.log`);
  let failed = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, ["-avd", id, "-no-window", "-gpu", "host", "-no-audio", "-no-boot-anim"], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.on("error", () => (failed = true));
    child.on("exit", (code) => (failed ||= code !== 0));
    child.unref();
  } finally {
    closeSync(log.fd);
  }

  try {
    return await poll(signal, 60_000, 200, () => new Error(`the emulator did not start; see ${log.path}`), () => {
      const r = running(id);
      if (r) return r;
      if (failed) throw new Error(`the emulator exited; see ${log.path}`);
    });
  } catch (err) {
    stop(child);
    throw err;
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
