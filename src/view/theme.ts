// Palette holds SGR parameters, combined by sgr.
export type Palette = {
  chip: string;
  chipText: string;
  accent: string;
  android: string;
  dim: string;
  text: string;
  frame: string;
  err: string;
};

export const dark: Palette = {
  chip: "48;2;50;50;55", chipText: "38;2;235;235;240",
  accent: "38;2;10;132;255", android: "38;2;61;220;132",
  dim: "38;2;142;142;147", text: "38;2;235;235;240", frame: "38;2;72;72;78",
  err: "38;2;255;69;58",
};

export const light: Palette = {
  chip: "48;2;222;222;228", chipText: "38;2;28;28;30",
  accent: "38;2;0;122;255", android: "38;2;20;160;90",
  dim: "38;2;142;142;147", text: "38;2;28;28;30", frame: "38;2;199;199;204",
  err: "38;2;255;59;48",
};

export function sgr(...params: string[]): string {
  return "\x1b[0;" + params.join(";") + "m";
}

// luminance reads a colour such as rgb:1e1e/1e1e/2020, where each channel
// has one to four hex digits.
export function luminance(spec: string): number | null {
  if (!spec.startsWith("rgb:")) return null;
  const parts = spec.slice(4).split("/");
  if (parts.length !== 3) return null;
  const c: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    c.push(parseInt(p, 16) / (2 ** (4 * p.length) - 1));
  }
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
