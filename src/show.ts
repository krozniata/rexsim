// rexsim show puts devices in the session's rexsim pane, opening one beside
// the calling pane when there is none, so an agent can let the user watch
// the devices it drives.
import { basename } from "node:path";
import * as control from "./control";
import { devices, find, label } from "./device";

export async function show(keys: string[]): Promise<void> {
  const session = process.env.REX_SESSION;
  if (!session) throw new Error("rexsim show runs inside Rex, which sets REX_SESSION");
  const reply = await control.request(control.controlPath(session), { show: keys });
  if (reply) {
    if (!reply.ok) throw new Error(reply.error);
    console.log(reply.message);
    return;
  }

  const all = await devices(new AbortController().signal);
  const chosen = keys.length > 0 ? keys.map((k) => find(all, k) ?? missing(k)) : all.filter((d) => d.booted);
  if (chosen.length === 0) throw new Error("no simulator or emulator is booted; name the ones to show");

  const block = process.env.REX_BLOCK;
  const self = basename(process.execPath) === "bun" ? [process.execPath, Bun.main] : [process.execPath];
  const args = ["--udid", chosen.map((d) => d.id).join(",")];
  if (block) args.push("--agent", block);
  const cmd = ["rex", "split", "-s", session, ...(block ? ["-b", block] : []), "--split=right", "--ratio", "35", "--focus=false", "--label", "rexsim", "--", ...self, ...args];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`rex split: ${(out + err).trim()}`);
  console.log(`opened rexsim with ${chosen.map(label).join(", ")}`);
}

function missing(key: string): never {
  throw new Error(`no simulator or emulator is called ${key}`);
}
