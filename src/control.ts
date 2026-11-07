// Lets "rexsim show" reach the rexsim that is already open in a Rex session,
// through a Unix socket named after the session.
import { createHash } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { socketDir } from "./paths";

export type Request = { show: string[] };
export type Reply = { ok: true; message: string } | { ok: false; error: string };

const replyTimeout = 10_000;

// controlPath hashes the session's ID, because a socket path must fit in
// 104 bytes.
export function controlPath(session: string): string {
  const h = createHash("sha256").update(session).digest("hex").slice(0, 16);
  return join(socketDir(), `ctl-${h}.sock`);
}

// serve answers requests, one JSON line each way, until the returned
// function stops it. The newest rexsim in a session takes the socket over,
// and only removes it on the way out if it is still its own.
export function serve(path: string, handle: (req: Request) => Promise<Reply>): () => void {
  try {
    unlinkSync(path);
  } catch {}
  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open(s) {
        s.data = { buf: "" };
      },
      async data(s, chunk) {
        s.data.buf += chunk.toString();
        const nl = s.data.buf.indexOf("\n");
        if (nl < 0) return;
        let reply: Reply;
        try {
          const req = JSON.parse(s.data.buf.slice(0, nl));
          reply = Array.isArray(req.show) ? await handle({ show: req.show.map(String) }) : { ok: false, error: "unknown request" };
        } catch (err) {
          reply = { ok: false, error: (err as Error).message };
        }
        s.end(JSON.stringify(reply) + "\n");
      },
    },
  });
  const ino = statSync(path).ino;
  return () => {
    server.stop(true);
    try {
      if (statSync(path).ino === ino) unlinkSync(path);
    } catch {}
  };
}

// request sends req to the rexsim serving path, or resolves null when none
// is.
export function request(path: string, req: Request): Promise<Reply | null> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new Error("rexsim didn't answer"))), replyTimeout);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify(req) + "\n");
        },
        data(_, chunk) {
          buf += chunk.toString();
        },
        close() {
          settle(() => {
            try {
              resolve(JSON.parse(buf));
            } catch {
              reject(new Error("rexsim closed the connection without an answer"));
            }
          });
        },
        error(_, err) {
          settle(() => reject(err));
        },
      },
    }).catch(() => settle(() => resolve(null)));
  });
}
