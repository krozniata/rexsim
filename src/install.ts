import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import actionLua from "./rexsim.lua" with { type: "text" };
import skillTemplate from "./skill.md" with { type: "text" };
import { run } from "./exec";

const requireLine = `require("rexsim")`;

const skillMarker = `Installed by "rexsim install"`;

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "rex") : join(homedir(), ".config", "rex");
}

// skillDirs are where agents look for the skill: Claude Code in its own
// directory, and Codex, OpenCode and Pi in the one they share, as with Rex's
// own skill.
function skillDirs(): string[] {
  return [
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills", "rexsim"),
    join(homedir(), ".agents", "skills", "rexsim"),
  ];
}

// install doesn't resolve symlinks in the binary's path, so a path that a
// package manager keeps stable across upgrades stays in the Lua file.
export async function install(): Promise<void> {
  const bin = process.execPath;
  if (basename(bin) === "bun") {
    throw new Error("compile rexsim first, as the README shows, then run rexsim install");
  }
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const luaPath = join(dir, "rexsim.lua");
  writeFileSync(luaPath, `-- rexsim install writes this file. Run it again after moving rexsim.\nlocal BIN = ${luaQuote(bin)}\n${actionLua}`);
  console.log("wrote", luaPath);

  const initPath = join(dir, "init.lua");
  let s = readFile(initPath);
  if (!lines(s).some(isRequire)) {
    if (s !== "" && !s.endsWith("\n")) s += "\n";
    writeFileSync(initPath, s + requireLine + "\n");
    console.log(`added ${requireLine} to ${initPath}`);
  }
  for (const dir of skillDirs()) installSkill(dir, bin);
  await reload();
  console.log('press shift+cmd+i, or run "Toggle rexsim" from the command palette, beside an agent');
}

// installSkill tells agents to show the devices they drive. A skill of the
// same name that rexsim didn't write is left alone.
function installSkill(dir: string, bin: string): void {
  const path = join(dir, "SKILL.md");
  const old = readFile(path);
  if (old !== "" && !old.includes(skillMarker)) {
    console.log(`left ${path} alone, since rexsim didn't write it`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, skillTemplate.replaceAll("{{rexsim}}", shellQuote(bin)));
  console.log("wrote", path);
}

function uninstallSkill(dir: string): void {
  const path = join(dir, "SKILL.md");
  if (!readFile(path).includes(skillMarker)) return;
  unlinkSync(path);
  try {
    rmdirSync(dir);
  } catch {}
  console.log("removed", path);
}

export async function uninstall(): Promise<void> {
  const dir = configDir();
  try {
    unlinkSync(join(dir, "rexsim.lua"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const initPath = join(dir, "init.lua");
  const s = readFile(initPath);
  const next = lines(s).filter((l) => !isRequire(l)).join("");
  if (next !== s) {
    writeFileSync(initPath, next);
    console.log(`removed ${requireLine} from ${initPath}`);
  }
  for (const dir of skillDirs()) uninstallSkill(dir);
  await reload();
}

async function reload(): Promise<void> {
  let detail: string;
  try {
    const { code, out } = await run(["rex", "config", "reload"]);
    detail = code === 0 ? "" : out || `exit status ${code}`;
  } catch (err) {
    detail = (err as Error).message;
  }
  if (detail) {
    console.log(`reload Rex's config yourself with: rex config reload (${detail})`);
    return;
  }
  console.log("reloaded Rex's config");
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

// lines splits s after each newline, keeping the newlines.
function lines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function isRequire(line: string): boolean {
  const t = line.trim();
  return t === requireLine || t.startsWith(requireLine + " --");
}

function shellQuote(s: string): string {
  return /^[\w./+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

function luaQuote(s: string): string {
  const escapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\0": "\\0" };
  return `"${s.replace(/[\\"\n\r\0]/g, (c) => escapes[c])}"`;
}
