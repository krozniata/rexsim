// rexsim show puts devices in the session's rexsim pane, opening one beside
// the calling pane when there is none, so an agent can let the user watch
// the devices it drives.
import { statSync } from "node:fs";
import { basename } from "node:path";
import * as control from "./control";
import { label, resolve } from "./device";
import { run } from "./exec";
import { devices } from "./platforms";

const paneTimeout = 3000;

export async function show(keys: string[]): Promise<void> {
  const session = process.env.REX_SESSION;
  if (!session) throw new Error("rexsim show runs inside Rex, which sets REX_SESSION");
  const path = control.controlPath(session);
  const reply = await control.request(path, { show: keys });
  if (reply) {
    if (!reply.ok) throw new Error(reply.error);
    console.log(reply.message);
    return;
  }

  const all = await devices(new AbortController().signal);
  const chosen = resolve(all, keys);

  const block = process.env.REX_BLOCK;
  const self = basename(process.execPath) === "bun" ? [process.execPath, Bun.main] : [process.execPath];
  const args = ["--udid", chosen.map((d) => d.id).join(",")];
  if (block) args.push("--agent", block);
  const cmd = ["rex", "split", "-s", session, ...(block ? ["-b", block] : []), "--split=right", "--ratio", "35", "--focus=false", "--label", "rexsim", "--", ...self, ...args];
  const old = inode(path);
  const { code, out } = await run(cmd);
  if (code !== 0) throw new Error(`rex split: ${out}`);
  // Returning once the new pane takes requests lets a "rexsim show" right
  // after this one reach it, rather than open another pane.
  for (const deadline = Date.now() + paneTimeout; inode(path) === old && Date.now() < deadline; ) await Bun.sleep(50);
  console.log(`opened rexsim with ${chosen.map(label).join(", ")}`);
}

// inode tells the socket a new pane makes from one a closed pane left behind.
function inode(path: string): number {
  try {
    return statSync(path).ino;
  } catch {
    return 0;
  }
}
