// rexsim shows an iOS simulator or Android emulator in a Rex pane that you
// can tap, swipe and type into.
import { parseArgs } from "node:util";
import { install, uninstall } from "./install";
import { show } from "./show";
import { run } from "./view/app";

const usage = `usage: rexsim [flags] | rexsim show [DEVICE...] | rexsim install | rexsim uninstall
  show DEVICE   shows simulators or emulators, by name, UDID, AVD name or adb serial, in this Rex session's
                rexsim pane, opening one beside this pane if needed. Without a DEVICE, it shows
                every booted one
  --udid ID     a device to show, as for show; repeat it or separate
                them with commas to show several. Without it, rexsim asks unless one is booted
  --agent ID    the Rex block that ^S sends screenshots to; the Rex action sets it
  --fps N       frames per second to stream (default 60)`;

async function main(args: string[]): Promise<void> {
  if (args[0] === "install") return install();
  if (args[0] === "uninstall") return uninstall();
  if (args[0] === "show") return show(args.slice(1));
  const { values } = parseArgs({
    args,
    options: {
      udid: { type: "string", multiple: true, default: [] },
      agent: { type: "string", default: "" },
      fps: { type: "string", default: "60" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const fps = Number(values.fps);
  if (!Number.isInteger(fps) || fps <= 0) throw new Error(`invalid --fps ${values.fps}`);
  const ids = values.udid.flatMap((s) => s.split(",")).map((u) => u.trim()).filter(Boolean);
  await run({ ids, agent: values.agent, fps });
}

try {
  await main(process.argv.slice(2));
  process.exit(0);
} catch (err) {
  console.error("rexsim:", err instanceof Error ? err.message : err);
  process.exit(1);
}
