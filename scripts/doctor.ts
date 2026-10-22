// alfred doctor: what works, what doesn't, and how to fix it. Checks go through the running
// service, because macOS permissions belong to it, not to Terminal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/paths.ts";
import * as k from "./kit.ts";

const { say, ok, warn, info, run } = k;
let problems = 0;
const bad = (line: string, ...fixes: string[]) => {
  problems++;
  warn(line);
  for (const f of fixes) info(f);
};

say("Alfred doctor\n");

if (!(await k.alfredUp(3000))) {
  const state = run("/bin/launchctl", ["print", `gui/${k.UID}/com.alfred.agent`]).out;
  bad(
    "Alfred isn't running.",
    state ? `launchd says: ${/state = (\w+)/.exec(state)?.[1] ?? "unknown"}` : "Its background service isn't installed: run setup.",
    "Check System Settings → General → Login Items & Extensions: Alfred must be allowed in the background.",
    `Last lines of its log (${join(paths.logs, "server.log")}):`,
    ...run("/usr/bin/tail", ["-n", "8", join(paths.logs, "server.log")]).out.split("\n"),
  );
} else {
  ok("Alfred is running");
  const s = await k.alfred("/status");
  if (s.model === "ok") ok("The AI model is ready");
  else bad(`Model: ${s.model}`, "Open the Ollama app (or: brew services start ollama).");
  if (s.messages === "ok") ok("Messages: readable");
  else if (/Full Disk Access/.test(s.messages)) {
    bad(
      "Messages: Alfred doesn't have Full Disk Access.",
      "System Settings → Privacy & Security → Full Disk Access: add Alfred (in ~/Applications) and switch it on,",
      "then: launchctl kickstart -k gui/$UID/com.alfred.agent",
    );
  } else bad(`Messages: ${s.messages}`);
  if (s.contacts === "ok") ok("Contacts: readable");
  else bad(`Contacts: ${s.contacts}`);
  for (const app of ["messages", "reminders"]) {
    const r = await k.alfred("/probe", { text: app }, 20_000).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) ok(`Allowed to use ${app === "messages" ? "Messages" : "Reminders"}`);
    else {
      bad(
        `Not allowed to use ${app === "messages" ? "Messages" : "Reminders"} (${r.error}).`,
        "System Settings → Privacy & Security → Automation → Alfred: switch it on. If Alfred isn't listed,",
        "run: tccutil reset AppleEvents com.alfred.agent   and then setup again, and click Allow.",
      );
    }
  }
  if (s.telegram === "ok") ok("Telegram: connected");
  else info("Telegram: not set up (optional; run setup to add it)");
  if (s.waiting) info(`Waiting for ${s.waiting} repl${s.waiting === 1 ? "y" : "ies"}`);
}

const ts = k.tailscaleStatus();
if (!k.tailscaleCli()) bad("Tailscale isn't installed: your iPhone can't reach Alfred.", "Run setup.");
else if (!ts.running) bad(`Tailscale isn't connected (${ts.state ?? "unknown"}).`, "Open Tailscale from the menu bar and log in.");
else {
  ok(`Tailscale: connected as ${ts.host}`);
  const serving = run(k.tailscaleCli()!, ["serve", "status"]).out;
  if (serving.includes("127.0.0.1:8787")) ok(`Reachable from your devices at https://${ts.host}`);
  else bad("Tailscale isn't forwarding to Alfred.", "Run: tailscale serve --bg --https=443 http://127.0.0.1:8787");
  if (k.env().TAILSCALE_HOST && k.env().TAILSCALE_HOST !== ts.host) {
    bad("This Mac's Tailscale name changed since setup, so the Shortcuts point at the old address.", "Run setup again.");
  }
}

if (k.env().BARK_DEVICE_KEY) {
  try {
    await fetch("http://127.0.0.1:8080/ping", { signal: AbortSignal.timeout(3000) });
    ok("Notifications: bark-server is running");
  } catch {
    bad("Notifications: bark-server isn't answering.", "Run: launchctl kickstart -k gui/$UID/com.alfred.bark");
  }
} else info("Notifications: not set up (run setup to add them)");

const shortcuts = run("/usr/bin/shortcuts", ["list"]).out.split("\n").map((l) => l.trim());
for (const name of ["Alfred", "Type to Alfred"]) {
  if (shortcuts.includes(name)) ok(`Shortcut "${name}" is installed`);
  else bad(`Shortcut "${name}" is missing.`, "Run setup again to add it.");
}

const log = join(paths.logs, "alfred.log");
if (existsSync(log)) {
  const errors = readFileSync(log, "utf8").trim().split("\n").filter((l) => /"error"/.test(l)).slice(-3);
  if (errors.length) {
    info("Recent errors:");
    for (const e of errors) info(`  ${e.slice(0, 200)}`);
  }
}

say(problems ? `\n${problems} thing${problems === 1 ? "" : "s"} to fix.` : "\nEverything looks good.");
k.done();
process.exit(problems ? 1 : 0);
