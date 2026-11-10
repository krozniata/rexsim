// rexsim shows an iOS simulator or Android emulator in a Rex pane that you
// can tap, swipe and type into.
import { parseArgs } from "node:util";
import { install, uninstall } from "./install";
import { show } from "./show";
import { upgrade } from "./upgrade";
import { run } from "./view/app";

// The release workflow defines REXSIM_VERSION when it builds a release.
declare const REXSIM_VERSION: string | undefined;
const version = typeof REXSIM_VERSION === "string" ? REXSIM_VERSION : "dev";

const usage = `usage: rexsim [flags] | rexsim show [DEVICE...] | rexsim install | rexsim uninstall | rexsim upgrade
  show DEVICE   shows simulators or emulators, by name, UDID, AVD name or adb serial, in this Rex session's
                rexsim pane, opening one beside this pane if needed. Without a DEVICE, it shows
                every booted one
  upgrade       replaces rexsim with the latest release, unless it is the latest already
  --udid ID     a device to show, as for show; repeat it or separate
                them with commas to show several. Without it, rexsim shows the booted ones, or
                the device list when none is
  --agent ID    the Rex block that ^S sends screenshots to; the Rex action sets it
  -h, --help    prints this help
  -v, --version prints rexsim's version`;

async function main(args: string[]): Promise<void> {
  if (args[0] === "help" || args.some((a) => a === "-h" || a === "--help")) {
    console.log(usage);
    return;
  }
  if (args[0] === "version" || args.some((a) => a === "-v" || a === "--version")) {
    console.log(`rexsim ${version}`);
    return;
  }
  if (args[0] === "install") return install();
  if (args[0] === "uninstall") return uninstall();
  if (args[0] === "upgrade") return upgrade(version);
  if (args[0] === "show") return show(args.slice(1));
  const { values } = parseArgs({
    args,
    options: {
      udid: { type: "string", multiple: true, default: [] },
      agent: { type: "string", default: "" },
    },
  });
  const ids = values.udid.flatMap((s) => s.split(",")).map((u) => u.trim()).filter(Boolean);
  await run({ ids, agent: values.agent, version });
}

try {
  await main(process.argv.slice(2));
  process.exit(0);
} catch (err) {
  console.error("rexsim:", err instanceof Error ? err.message : err);
  process.exit(1);
}
