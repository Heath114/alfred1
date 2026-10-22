// Small helpers shared by setup.ts and doctor.ts. Only runs on the Mac.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readEnv } from "../src/envfile.ts";
import { paths } from "../src/paths.ts";

export const ROOT = join(import.meta.dirname, "..");
export const ENV_FILE = join(ROOT, ".env");
export const UID = userInfo().uid;
export const env = () => readEnv(ENV_FILE);

export const say = (line = "") => console.log(line);
export const ok = (line: string) => console.log(`  ✓ ${line}`);
export const warn = (line: string) => console.log(`  ! ${line}`);
export const info = (line: string) => console.log(`    ${line}`);
export const step = (n: number, title: string) => console.log(`\n${n}. ${title}\n${"-".repeat(title.length + 3)}`);

export function run(cmd: string, args: string[] = [], opts: { timeout?: number; input?: string } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 60_000, input: opts.input });
  return { code: r.status ?? (r.error ? 127 : 1), out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// For commands that talk to the person directly (sudo password, installers).
export function runVisible(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1;
}

export const has = (cmd: string) => run("/usr/bin/which", [cmd]).code === 0;
export const firstExisting = (...files: string[]) => files.find((f) => existsSync(f));

const rl = createInterface({ input: process.stdin, output: process.stdout });
export const ask = async (q: string) => (await rl.question(`  ? ${q} `)).trim();
export const pause = async (q = "Press Enter when that's done.") => void (await rl.question(`  → ${q} `));
export async function confirm(q: string, yes = true): Promise<boolean> {
  const a = (await rl.question(`  ? ${q} ${yes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return a ? a.startsWith("y") : yes;
}
export const done = () => rl.close();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const openUrl = (url: string) => run("/usr/bin/open", [url]);

// System Settings panes (macOS 13+).
export const SETTINGS = {
  fullDiskAccess: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
  loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
  users: "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension",
  fileVault: "x-apple.systempreferences:com.apple.preference.security?FileVault",
};

// Talking to the running Alfred service, which is what holds the permissions.
const port = () => env().PORT || "8787";
export async function alfred(path: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${env().ALFRED_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Alfred answered ${res.status}`);
  return res.json();
}

export async function alfredUp(waitMs = 30_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  do {
    try {
      const res = await fetch(`http://127.0.0.1:${port()}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  } while (Date.now() < until);
  return false;
}

// Installs (or reinstalls) a LaunchAgent and starts it: bootout, bootstrap, enable, kickstart.
export function installAgent(label: string, plist: string): { ok: boolean; error?: string } {
  mkdirSync(paths.launchAgents, { recursive: true });
  const file = join(paths.launchAgents, `${label}.plist`);
  writeFileSync(file, plist);
  chmodSync(file, 0o644);
  run("/bin/launchctl", ["bootout", `gui/${UID}/${label}`]);
  const boot = run("/bin/launchctl", ["bootstrap", `gui/${UID}`, file]);
  if (boot.code !== 0 && !/already/i.test(boot.err)) return { ok: false, error: boot.err || boot.out };
  run("/bin/launchctl", ["enable", `gui/${UID}/${label}`]);
  run("/bin/launchctl", ["kickstart", "-k", `gui/${UID}/${label}`]);
  return { ok: true };
}

export const restartAlfred = () => run("/bin/launchctl", ["kickstart", "-k", `gui/${UID}/com.alfred.agent`]);

export function tailscaleCli(): string | undefined {
  return firstExisting(
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  );
}

export function tailscaleStatus(): { running: boolean; host?: string; login?: string; state?: string } {
  const cli = tailscaleCli();
  if (!cli) return { running: false };
  const r = run(cli, ["status", "--json"], { timeout: 15_000 });
  try {
    const s = JSON.parse(r.out);
    const host = String(s.Self?.DNSName ?? "").replace(/\.$/, "") || undefined;
    const login = s.User?.[String(s.Self?.UserID)]?.LoginName;
    return { running: s.BackendState === "Running", host, login, state: s.BackendState };
  } catch {
    return { running: false, state: r.err || r.out };
  }
}
