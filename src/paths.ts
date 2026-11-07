import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(): string {
  return join(homedir(), "Library", "Caches", "rexsim");
}

// socketDir returns rexsim's private directory for Unix sockets, creating it
// with mode 0700. It lives in /tmp, not $TMPDIR, because a socket path must
// fit in 104 bytes.
export function socketDir(): string {
  const dir = `/tmp/rexsim-${process.getuid!()}`;
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!()) {
    throw new Error(`${dir} is not a directory owned by you`);
  }
  chmodSync(dir, 0o700);
  return dir;
}
