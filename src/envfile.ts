// Reading and updating .env without disturbing its comments or other settings.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

// Sets KEY=value: replaces an existing (or commented-out) line for KEY, otherwise appends.
export function setEnv(file: string, values: Record<string, string>): void {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const existing = new RegExp(`^\\s*#?\\s*${key}=.*$`, "m");
    text = existing.test(text) ? text.replace(existing, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(file, text);
  chmodSync(file, 0o600); // it holds Alfred's password and keys
}
