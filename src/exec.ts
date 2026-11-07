// Runs other programs and waits on them.
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./paths";

// run runs a command to the end. out is its stdout, or its stdout and stderr
// together when it fails.
export async function run(cmd: string[], signal?: AbortSignal): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", signal });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: code === 0 ? out : (out + err).trim() };
}

// ok reports whether a command ran and succeeded. Bun.spawn throws at once
// when the program isn't on PATH.
export async function ok(cmd: string[], stdin?: Uint8Array): Promise<boolean> {
  try {
    return (await Bun.spawn(cmd, { stdin: stdin ?? "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}

// openLog creates a file in rexsim's cache directory, readable only by you,
// for a background program's output.
export function openLog(name: string): { path: string; fd: number } {
  const root = cacheDir();
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  return { path, fd: openSync(path, "w", 0o600) };
}

// poll calls check every interval milliseconds until it returns a value. It
// throws signal's reason once signal aborts, even from inside check, and
// expired()'s error once timeout milliseconds have passed.
export async function poll<T>(
  signal: AbortSignal,
  timeout: number,
  interval: number,
  expired: () => Error,
  check: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v: T | undefined;
    try {
      v = await check();
    } catch (err) {
      throw signal.aborted ? signal.reason : err;
    }
    if (v !== undefined) return v;
    if (signal.aborted) throw signal.reason;
    if (Date.now() > deadline) throw expired();
    await Bun.sleep(interval);
  }
}
