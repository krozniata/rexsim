// Installs and runs Meta's idb_companion, which reads the simulator's
// framebuffer and injects HID events through CoreSimulator.
import { closeSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openLog, poll } from "../exec";
import { cacheDir, socketDir } from "../paths";

const version = "1.7.8";
const archiveURL = `https://github.com/facebook/idb/releases/download/v${version}/idb-companion.macos-arm64.tar.gz`;
const archiveSHA256 = "44369a2df0b62e3a1764de61bd09280999c7e9b27ea8f20bff1ea3a9db0302a2";

let pending: Promise<string> | null = null;

// binary returns the path of idb_companion. It downloads the pinned release
// on first use, once for every simulator that waits on it, and again after a
// failed download. The download isn't cancelled with any one simulator.
export function binary(progress: (text: string) => void): Promise<string> {
  pending ??= download(progress).catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

async function download(progress: (text: string) => void): Promise<string> {
  const dir = join(cacheDir(), `idb-companion-${version}`);
  const bin = join(dir, "idb_companion");
  try {
    if (statSync(bin).mode & 0o111) return bin;
  } catch {}
  progress(`downloading idb_companion ${version}…`);
  const res = await fetch(archiveURL);
  if (!res.ok) throw new Error(`download ${archiveURL}: ${res.status} ${res.statusText}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (new Bun.CryptoHasher("sha256").update(data).digest("hex") !== archiveSHA256) {
    throw new Error("idb_companion download has the wrong checksum");
  }
  const partial = `${dir}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  try {
    await extract(data, partial);
    renameSync(partial, dir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  return bin;
}

// extract unpacks with macOS's bsdtar, which refuses entries with absolute
// paths or ".." unless given -P.
async function extract(data: Uint8Array, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const tar = Bun.spawn(["tar", "-xzf", "-", "-C", dest], { stdin: data, stdout: "ignore", stderr: "pipe" });
  if ((await tar.exited) !== 0) {
    throw new Error(`extract idb_companion: ${(await new Response(tar.stderr).text()).trim()}`);
  }
}

export class Companion {
  private closed: Promise<void> | null = null;

  constructor(
    readonly socket: string,
    private proc: Bun.Subprocess,
  ) {}

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill("SIGTERM");
        const timer = setTimeout(() => this.proc.kill("SIGKILL"), 2000);
        await this.proc.exited;
        clearTimeout(timer);
      }
      try {
        unlinkSync(this.socket);
      } catch {}
    })();
    return this.closed;
  }
}

// start runs a companion for one simulator on a private Unix socket. A TCP
// port would listen on every interface without authentication.
export async function start(signal: AbortSignal, bin: string, udid: string): Promise<Companion> {
  const short = udid.slice(0, 8);
  const sock = join(socketDir(), `${process.pid}-${short}.sock`);
  try {
    unlinkSync(sock);
  } catch {}

  const log = openLog(`companion-${short}.log`);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([bin, "--udid", udid, "--grpc-domain-sock", sock], { stdin: "ignore", stdout: log.fd, stderr: log.fd });
  } finally {
    closeSync(log.fd);
  }
  const c = new Companion(sock, proc);
  let exited = false;
  proc.exited.then(() => (exited = true));

  try {
    await poll(signal, 30_000, 50, () => new Error(`idb_companion did not start; see ${log.path}`), () => {
      if (existsSync(sock)) return true;
      if (exited) throw new Error(`idb_companion exited; see ${log.path}`);
    });
  } catch (err) {
    await c.close();
    throw err;
  }
  return c;
}
