import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../device";
import { ok } from "../exec";
import type { App } from "./app";
import type { Phone } from "./phone";

// sendScreenshot saves a full-resolution screenshot of a phone and types
// its path into the agent's pane, so the agent can look at the screen.
// Without an agent, it copies the path.
export async function sendScreenshot(a: App, p: Phone, session: Session): Promise<void> {
  let path: string;
  try {
    const png = await session.screenshot();
    const dir = join(tmpdir(), "rexsim");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = p.device.name.replace(/[ /]/g, "-");
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    path = join(dir, `${name}-${time}-${randomBytes(4).toString("hex")}.png`);
    writeFileSync(path, png, { flag: "wx", mode: 0o600 });
  } catch (err) {
    a.flash((err as Error).message);
    return;
  }
  if (a.opts.agent && (await rexSend(a.opts.agent, path + " "))) {
    a.flash(`Sent a screenshot of ${p.device.name} to the agent's input`);
    return;
  }
  if (!(await ok(["pbcopy"], new TextEncoder().encode(path)))) {
    a.flash(`Saved ${path}`);
    return;
  }
  a.flash(`Copied the screenshot's path: ${path}`);
}

function rexSend(block: string, text: string): Promise<boolean> {
  return ok(["rex", "send", "-s", process.env.REX_SESSION ?? "", "-b", block, text]);
}
