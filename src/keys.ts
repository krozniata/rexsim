// USB HID keyboard usages (page 7).
export const KeyEnter = 40;
export const KeyEscape = 41;
export const KeyBackspace = 42;
export const KeyTab = 43;
export const KeyRight = 79;
export const KeyLeft = 80;
export const KeyDown = 81;
export const KeyUp = 82;
export const KeyLeftShift = 225;

const symbols: Record<string, [code: number, shift: boolean]> = {
  " ": [44, false], "\n": [KeyEnter, false], "\t": [KeyTab, false],
  "-": [45, false], _: [45, true], "=": [46, false], "+": [46, true],
  "[": [47, false], "{": [47, true], "]": [48, false], "}": [48, true],
  "\\": [49, false], "|": [49, true], ";": [51, false], ":": [51, true],
  "'": [52, false], '"': [52, true], "`": [53, false], "~": [53, true],
  ",": [54, false], "<": [54, true], ".": [55, false], ">": [55, true],
  "/": [56, false], "?": [56, true],
  "!": [30, true], "@": [31, true], "#": [32, true], $: [33, true], "%": [34, true],
  "^": [35, true], "&": [36, true], "*": [37, true], "(": [38, true], ")": [39, true],
};

export function keyFor(ch: string): { code: number; shift: boolean } | null {
  const c = ch.codePointAt(0) ?? 0;
  if (ch >= "a" && ch <= "z" && ch.length === 1) return { code: 4 + c - 97, shift: false };
  if (ch >= "A" && ch <= "Z" && ch.length === 1) return { code: 4 + c - 65, shift: true };
  if (ch >= "1" && ch <= "9" && ch.length === 1) return { code: 30 + c - 49, shift: false };
  if (ch === "0") return { code: 39, shift: false };
  const s = symbols[ch];
  return s ? { code: s[0], shift: s[1] } : null;
}

// keysFor lists the taps that type s on a US keyboard, skipping characters
// it doesn't have.
export function keysFor(s: string): { code: number; shift: boolean }[] {
  return [...s].flatMap((ch) => keyFor(ch) ?? []);
}
