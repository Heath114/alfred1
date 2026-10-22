// Sets Alfred up on the Mac, step by step. Safe to run again: finished steps are checked and
// skipped. Start it with ./setup.sh (which first fetches the pinned Node).
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";
import { setEnv } from "../src/envfile.ts";
import { alfredAgent, appInfoPlist, barkAgent, LABELS, watchdogAgent } from "../src/install.ts";
import { paths } from "../src/paths.ts";
import { DEFAULT_MODEL } from "../src/server.ts";
import { alfredShortcut } from "../src/shortcut.ts";
import { toPlist } from "../src/plist.ts";
import { telegramLogin } from "../src/telegram.ts";
import * as k from "./kit.ts";

const { ROOT, ENV_FILE, UID, say, ok, warn, info, step, run, runVisible, ask, pause, confirm, alfred } = k;

if (platform() !== "darwin") {
  console.error("Alfred's setup runs on the Mac.");
  process.exit(1);
}

say("Setting up Alfred. Each step checks what's already done, so you can run this again any time.");

// 1 ──────────────────────────────────────────────────────────────────────────────────────────────
step(1, "This Mac");
const macos = run("/usr/bin/sw_vers", ["-productVersion"]).out;
ok(`macOS ${macos} (Darwin ${release()})`);
if (process.env.SSH_CONNECTION) {
  warn("You're connected over SSH. macOS only shows permission prompts on the Mac's own screen,");
  info("so run setup at the Mac itself, or through Screen Sharing.");
  if (!(await confirm("Continue anyway?", false))) process.exit(1);
}
for (const dir of [paths.files, paths.state, paths.logs]) mkdirSync(dir, { recursive: true });

// 2 ──────────────────────────────────────────────────────────────────────────────────────────────
step(2, "Alfred's settings");
if (!existsSync(ENV_FILE)) copyFileSync(join(ROOT, ".env.example"), ENV_FILE);
if (!k.env().ALFRED_KEY) setEnv(ENV_FILE, { ALFRED_KEY: randomBytes(24).toString("base64url") });
if (!k.env().MODEL) setEnv(ENV_FILE, { MODEL: DEFAULT_MODEL });
ok(`Settings in ${ENV_FILE} (Alfred's password is in there; the Shortcuts get it automatically)`);

// 3 ──────────────────────────────────────────────────────────────────────────────────────────────
step(3, "The AI model (runs on this Mac)");
const ollamaUp = async () => {
  try {
    return (await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};
if (!(await ollamaUp())) {
  const brew = k.firstExisting("/opt/homebrew/bin/brew");
  const app = existsSync("/Applications/Ollama.app");
  if (!app && !k.has("ollama")) {
    if (brew && (await confirm("Install Ollama (the model runner) with Homebrew?"))) {
      runVisible(brew, ["install", "ollama"]);
      runVisible(brew, ["services", "start", "ollama"]);
    } else {
      info("Downloading Ollama...");
      const zip = join(paths.state, "Ollama-darwin.zip");
      if (run("/usr/bin/curl", ["-fsSL", "https://ollama.com/download/Ollama-darwin.zip", "-o", zip], { timeout: 600_000 }).code !== 0) {
        warn("Couldn't download Ollama. Install it from https://ollama.com/download, then run setup again.");
        process.exit(1);
      }
      run("/usr/bin/ditto", ["-xk", zip, "/Applications"]);
      run("/usr/bin/open", ["-a", "Ollama"]);
      info("Ollama opened. If it asks to install its command line tool, that's fine either way.");
    }
  } else if (app) {
    run("/usr/bin/open", ["-a", "Ollama"]);
  } else if (brew) {
    run(brew, ["services", "start", "ollama"]);
  }
  for (let i = 0; i < 60 && !(await ollamaUp()); i++) await k.sleep(1000);
}
if (!(await ollamaUp())) {
  warn("Ollama isn't answering. Open the Ollama app, then run setup again.");
  process.exit(1);
}
ok("Ollama is running");

const model = k.env().MODEL || DEFAULT_MODEL;
const tags = (await (await fetch("http://127.0.0.1:11434/api/tags")).json()) as { models: { name: string }[] };
if (tags.models.some((m) => m.name === model || m.name === `${model}:latest`)) {
  ok(`Model ${model} is downloaded`);
} else {
  info(`Downloading ${model} (about 6.6 GB, once)...`);
  const res = await fetch("http://127.0.0.1:11434/api/pull", { method: "POST", body: JSON.stringify({ model, stream: true }) });
  let shown = -1;
  let buffer = "";
  for await (const chunk of res.body!) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const p = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (p.error) {
        warn(`Download failed: ${p.error}`);
        process.exit(1);
      }
      const pct = p.total && p.completed ? Math.floor((p.completed / p.total) * 100) : -1;
      if (pct >= 0 && pct >= shown + 10) {
        shown = pct - (pct % 10);
        info(`${shown}%`);
      }
    }
  }
  ok(`Model ${model} downloaded`);
}

// 4 ──────────────────────────────────────────────────────────────────────────────────────────────
step(4, "Alfred.app (holds Alfred's macOS permissions)");
const wrapperSource = readFileSync(join(ROOT, "mac", "wrapper.c"));
const buildId = createHash("sha256").update(wrapperSource).update(appInfoPlist()).digest("hex");
// Kept outside the app: adding a file to a signed app breaks its signature.
const stamp = join(paths.state, "alfred-app.build-id");
if (existsSync(stamp) && readFileSync(stamp, "utf8") === buildId) {
  ok("Alfred.app is up to date (left untouched, so its permissions stay)");
} else {
  const rebuilding = existsSync(paths.app);
  if (!k.has("clang")) {
    warn("Apple's command line tools are missing. Run: xcode-select --install, then setup again.");
    process.exit(1);
  }
  mkdirSync(join(paths.app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(paths.app, "Contents", "Info.plist"), appInfoPlist());
  const cc = run("clang", ["-O2", "-Wall", "-o", join(paths.app, "Contents", "MacOS", "Alfred"), join(ROOT, "mac", "wrapper.c")]);
  if (cc.code !== 0) {
    warn(`Building Alfred.app failed:\n${cc.err}`);
    process.exit(1);
  }
  const sign = run("/usr/bin/codesign", ["--force", "--sign", "-", paths.app]);
  if (sign.code !== 0) warn(`codesign: ${sign.err}`);
  writeFileSync(stamp, buildId);
  ok(`Built ${paths.app}`);
  if (rebuilding) warn("Alfred.app changed, so macOS will ask for its permissions again in step 6.");
}

// 5 ──────────────────────────────────────────────────────────────────────────────────────────────
step(5, "Starting Alfred in the background");
const node = k.firstExisting(join(paths.state, "runtime", "node", "bin", "node")) ?? process.execPath;
const installed = k.installAgent(LABELS.alfred, alfredAgent({ node, appDir: ROOT, uid: UID }));
if (!installed.ok) {
  warn(`launchctl refused Alfred's service: ${installed.error}`);
  process.exit(1);
}
k.installAgent(LABELS.watchdog, watchdogAgent(UID));
if (!(await k.alfredUp())) {
  warn("Alfred didn't start. The end of its log:");
  info(run("/usr/bin/tail", ["-n", "20", join(paths.logs, "server.log")]).out);
  process.exit(1);
}
ok("Alfred is running, and starts by itself when you log in");
info('macOS may show "Background Items Added": that\'s Alfred. Keep it allowed in');
info("System Settings → General → Login Items & Extensions.");

// 6 ──────────────────────────────────────────────────────────────────────────────────────────────
step(6, "Permissions");
for (let tries = 0; ; tries++) {
  const status = await alfred("/status", undefined, 60_000);
  if (status.messages === "ok") {
    ok("Alfred can read Messages (Full Disk Access)");
    if (status.contacts === "ok") ok("Alfred can read Contacts");
    else warn(`Contacts: ${status.contacts}. Alfred can still work with phone numbers; check Contacts later.`);
    break;
  }
  if (/isn't set up/.test(status.messages)) {
    warn(status.messages);
    run("/usr/bin/open", ["-a", "Messages"]);
    info('In Messages → Settings → iMessage, also turn on "Enable Messages in iCloud", so this Mac has');
    info("the same conversations as your iPhone. (The first sync can take a while.)");
    await pause();
    continue;
  }
  if (tries === 3) {
    warn(`Still no access (${status.messages}). Check Full Disk Access for Alfred and run setup again.`);
    process.exit(1);
  }
  info("Alfred needs Full Disk Access to read your messages and contacts. Opening the setting,");
  info("and a Finder window with Alfred in it:");
  k.openUrl(k.SETTINGS.fullDiskAccess);
  run("/usr/bin/open", ["-R", paths.app]);
  info("Drag Alfred from the Finder window into the Full Disk Access list, and switch it on.");
  info("(If macOS asks to quit and reopen Alfred, choose Later.)");
  await pause();
  k.restartAlfred();
  await k.alfredUp();
}
for (const app of ["messages", "reminders"] as const) {
  const name = app === "messages" ? "Messages" : "Reminders";
  for (let tries = 0; ; tries++) {
    info(`Asking macOS whether Alfred may use ${name}. If a box appears, click Allow (or OK).`);
    const r = await alfred("/probe", { text: app }, 320_000);
    if (r.ok) {
      ok(`Alfred can use ${name}`);
      break;
    }
    if (tries === 2) {
      warn(`macOS still says no for ${name} (${r.error}). Turn it on in System Settings → Privacy & Security`);
      info("→ Automation → Alfred, then run setup again.");
      break;
    }
    info(`Not allowed yet (${r.error}). Opening Automation settings: switch on ${name} under Alfred.`);
    info(`If Alfred isn't listed, this resets the question so macOS asks again.`);
    run("/usr/bin/tccutil", ["reset", "AppleEvents", "com.alfred.agent"]);
    k.openUrl(k.SETTINGS.automation);
    await pause();
  }
}

// 7 ──────────────────────────────────────────────────────────────────────────────────────────────
step(7, "Who's who");
const peopleFile = join(paths.files, "people.json");
const people: Record<string, string> = existsSync(peopleFile) ? JSON.parse(readFileSync(peopleFile, "utf8")) : {};
if (Object.keys(people).length) ok(`Known: ${Object.entries(people).map(([a, n]) => `${a} = ${n}`).join(", ")}`);
info('Tell Alfred what you call people, so "text my partner" works. Names as they are in Contacts.');
for (;;) {
  const alias = (await ask('What you call someone (like "partner" or "mom"), or Enter to finish:')).toLowerCase();
  if (!alias) break;
  const name = await ask(`Their name in Contacts:`);
  const found: string[] = await alfred("/contacts", { text: name }).catch(() => []);
  const exact = found.find((f) => f.toLowerCase() === name.toLowerCase());
  if (!found.length) {
    warn(`No contact matches "${name}". Check the spelling in Contacts and try again.`);
    continue;
  }
  people[alias] = exact ?? (found.length === 1 ? found[0] : name);
  if (!exact && found.length > 1) warn(`Several contacts match: ${found.join(", ")}. Using "${name}"; be more specific if needed.`);
  ok(`"${alias}" = ${people[alias]}`);
}
writeFileSync(peopleFile, JSON.stringify(people, null, 2) + "\n");

// 8 ──────────────────────────────────────────────────────────────────────────────────────────────
step(8, "Telegram (optional)");
if (existsSync(join(paths.state, "telegram.session")) && k.env().TELEGRAM_API_ID) {
  ok("Telegram is connected");
} else if (await confirm("Let Alfred read and send Telegram messages as you?", false)) {
  info("Telegram needs an app ID for your account. Opening my.telegram.org: log in, choose");
  info('"API development tools", create an app (any name), and copy the two values here.');
  k.openUrl("https://my.telegram.org");
  const apiId = await ask("api_id:");
  const apiHash = await ask("api_hash:");
  setEnv(ENV_FILE, { TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
  try {
    await telegramLogin(Number(apiId), apiHash, ask);
    ok("Telegram connected (the login stays on this Mac)");
    k.restartAlfred();
  } catch (err) {
    warn(`Telegram login failed: ${err instanceof Error ? err.message : err}. Run setup again to retry.`);
  }
}

// 9 ──────────────────────────────────────────────────────────────────────────────────────────────
step(9, "Reaching Alfred from your iPhone (Tailscale)");
if (!k.tailscaleCli()) {
  const brew = k.firstExisting("/opt/homebrew/bin/brew");
  if (brew && (await confirm("Install Tailscale with Homebrew?"))) {
    runVisible(brew, ["install", "--cask", "tailscale-app"]);
  } else {
    info("Opening Tailscale's download page. Install the Mac app (not the App Store one is fine too).");
    k.openUrl("https://tailscale.com/download/mac");
    await pause("Press Enter once Tailscale is installed.");
  }
}
let ts = k.tailscaleStatus();
while (!ts.running) {
  info("Open Tailscale (menu bar), log in, and allow its network extension if macOS asks.");
  info("In Tailscale's Settings, also choose \"Install CLI\" if it offers.");
  run("/usr/bin/open", ["-a", "Tailscale"]);
  await pause("Press Enter once Tailscale says Connected.");
  ts = k.tailscaleStatus();
  if (!ts.running && !k.tailscaleCli()) warn("Can't find Tailscale's command line tool yet.");
}
ok(`Tailscale is connected as ${ts.host}`);
const cli = k.tailscaleCli()!;
const served = (port: string) => run(cli, ["serve", "status"]).out.includes(`127.0.0.1:${port}`);
while (!served("8787")) {
  info("Putting Alfred on your private Tailscale network. If Tailscale shows a link to turn on HTTPS,");
  info("open it and approve; Tailscale waits for that and then continues.");
  runVisible(cli, ["serve", "--bg", "--https=443", "http://127.0.0.1:8787"]);
  if (!served("8787")) {
    warn("That didn't take. In the Tailscale admin console → DNS, turn on MagicDNS and HTTPS Certificates.");
    k.openUrl("https://login.tailscale.com/admin/dns");
    await pause();
  }
}
ok(`Alfred is on your tailnet at https://${ts.host}`);
const firstTailscaleSetup = k.env().TAILSCALE_HOST !== ts.host;
setEnv(ENV_FILE, { TAILSCALE_HOST: ts.host!, ...(ts.login ? { TAILSCALE_USER: ts.login } : {}) });
k.restartAlfred();
await k.alfredUp();
info("Checking the address (the first time takes a little while for the certificate)...");
const reachable = run("/usr/bin/curl", ["-fsS", "--max-time", "60", `https://${ts.host}/`]).code === 0;
if (reachable) ok(`Alfred answers at https://${ts.host}`);
else warn(`https://${ts.host} didn't answer from this Mac yet. If it keeps failing, run: alfred doctor`);
if (firstTailscaleSetup) {
  info("Two things in Tailscale's admin page (opening it now):");
  info("  • Machines → this Mac → ⋯ → Disable key expiry (otherwise it drops off after 180 days).");
  info("  • DNS: MagicDNS and HTTPS Certificates on (done if the address worked).");
  k.openUrl("https://login.tailscale.com/admin/machines");
  info("Also add Tailscale to System Settings → General → Login Items, so it starts after a restart.");
  info("On your iPhone: install Tailscale from the App Store, log in with the same account, and turn on");
  info("VPN On Demand in its settings, so the phone can always reach the Mac.");
  await pause("Press Enter to continue.");
}

// 10 ─────────────────────────────────────────────────────────────────────────────────────────────
step(10, "Notifications on your iPhone (Bark)");
const bark = join(paths.state, "bark", "bark-server");
const wantBark = !k.env().BARK_DEVICE_KEY && (await confirm("Set up notifications (Alfred tells you when jobs finish or replies arrive)?"));
if (k.env().BARK_DEVICE_KEY) ok("Bark is set up");
if (wantBark) {
  mkdirSync(join(paths.state, "bark", "data"), { recursive: true });
  if (!existsSync(bark)) {
    info("Downloading bark-server...");
    const url = "https://github.com/Finb/bark-server/releases/latest/download/bark-server_darwin_arm64";
    if (run("/usr/bin/curl", ["-fsSL", url, "-o", bark], { timeout: 300_000 }).code === 0) {
      run("/bin/chmod", ["+x", bark]);
      run("/usr/bin/codesign", ["--force", "--sign", "-", bark]); // Apple silicon only runs signed programs
    } else {
      rmSync(bark, { force: true });
    }
  }
}
if (wantBark && !existsSync(bark)) {
  warn("Couldn't download bark-server, so notifications are skipped for now. Run setup again to retry.");
} else if (wantBark) {
  k.installAgent(LABELS.bark, barkAgent({ server: bark, dataDir: join(paths.state, "bark", "data") }));
  if (!served("8080")) runVisible(cli, ["serve", "--bg", "--https=8443", "http://127.0.0.1:8080"]);
  const key = randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").padEnd(32, "x").slice(0, 32);
  run("/usr/bin/pbcopy", [], { input: key });
  info("On your iPhone:");
  info("  1. Install Bark from the App Store and open it (allow notifications).");
  info(`  2. Settings (gear) → Servers → + → https://${ts.host}:8443`);
  info("     then delete the default api.day.app server.");
  info("  3. Settings → Push Encryption: Algorithm AES256, Mode GCM, and this Key");
  info(`     (it's on your Mac's clipboard, so you can paste it on the iPhone): ${key}`);
  info("  4. Back on Servers, tap your server and copy its address (it ends in your device key).");
  let deviceKey = "";
  while (!deviceKey) {
    const pasted = await ask("Paste that address (or just the key) here:");
    try {
      deviceKey = /^https?:\/\//.test(pasted) ? (new URL(pasted).pathname.split("/").find(Boolean) ?? "") : pasted;
    } catch {
      warn("That doesn't look like the server address. Copy it again from Bark.");
    }
  }
  setEnv(ENV_FILE, { BARK_URL: "http://127.0.0.1:8080", BARK_DEVICE_KEY: deviceKey, BARK_ENCRYPTION_KEY: key });
  k.restartAlfred();
  await k.alfredUp();
  await alfred("/notify", { title: "Alfred", text: "Notifications work. 🎩" });
  if (await confirm('Did "Notifications work" arrive on your iPhone?')) ok("Notifications are set up");
  else warn("Check the server address and encryption key in Bark, then run setup again.");
}

// 11 ─────────────────────────────────────────────────────────────────────────────────────────────
step(11, "Keeping the Mac awake and Alfred running");
if (await confirm("Set the Mac to never sleep and to restart after a power cut? (asks for your password)")) {
  runVisible("/usr/bin/sudo", ["/usr/bin/pmset", "-a", "sleep", "0", "disksleep", "0", "standby", "0", "powernap", "0", "womp", "1", "autorestart", "1"]);
}
const fileVault = run("/usr/bin/fdesetup", ["status"]).out;
if (/On/.test(fileVault)) {
  info("FileVault is on, which keeps your disk encrypted. The trade-off: after a restart or power cut");
  info("the Mac waits for your password before anything runs, so Alfred stays off until you log in.");
  info("Keeping it on is the private choice. To let the Mac come back by itself instead, turn FileVault");
  info("off and then turn on automatic login (System Settings → Users & Groups).");
} else if (run("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]).code !== 0) {
  info("To bring Alfred back by itself after a restart, turn on automatic login: System Settings →");
  info("Users & Groups → Automatically log in as: you. Opening it now.");
  k.openUrl(k.SETTINGS.users);
  await pause("Press Enter to continue.");
} else {
  ok("Automatic login is on, so Alfred comes back by itself after a restart");
}

// 12 ─────────────────────────────────────────────────────────────────────────────────────────────
step(12, "The Alfred Shortcuts (iPhone and Mac)");
const shortcutsDir = join(paths.state, "shortcuts");
mkdirSync(join(shortcutsDir, "unsigned"), { recursive: true });
const listShortcuts = () => run("/usr/bin/shortcuts", ["list"]).out.split("\n").map((s) => s.trim());
const url = `https://${ts.host}/command`;
const installedFile = join(shortcutsDir, "installed.json");
const fingerprint = createHash("sha256").update(url).update(k.env().ALFRED_KEY).update(readFileSync(join(ROOT, "src", "shortcut.ts"))).digest("hex");
const previous = existsSync(installedFile) ? JSON.parse(readFileSync(installedFile, "utf8")).fingerprint : "";
const names = ["Alfred", "Type to Alfred"];
if (previous === fingerprint && names.every((n) => listShortcuts().includes(n))) {
  ok("Both Shortcuts are installed and current");
} else {
  for (const name of names) {
    const unsigned = join(shortcutsDir, "unsigned", `${name}.shortcut`);
    const signed = join(shortcutsDir, `${name}.shortcut`);
    writeFileSync(unsigned, toPlist(alfredShortcut({ url, key: k.env().ALFRED_KEY, typed: name !== "Alfred" })));
    run("/usr/bin/plutil", ["-convert", "binary1", unsigned]);
    rmSync(signed, { force: true });
    // "people who know me": signed with your own Apple Account, works on your own devices, and
    // nothing is uploaded. (The Shortcut contains Alfred's password.)
    let s = run("/usr/bin/shortcuts", ["sign", "--mode", "people-who-know-me", "--input", unsigned, "--output", signed], { timeout: 180_000 });
    if (s.code !== 0) s = run("/usr/bin/shortcuts", ["sign", "--mode", "people-who-know-me", "--input", unsigned, "--output", signed], { timeout: 180_000 });
    if (s.code !== 0) {
      warn(`macOS couldn't sign "${name}": ${s.err || s.out}`);
      info("Check you're signed into iCloud (System Settings → your name), then run setup again.");
      process.exit(1);
    }
    while (listShortcuts().includes(name)) {
      info(`You already have a shortcut called "${name}" (maybe the one you started by hand).`);
      info("Delete it in the Shortcuts app (right-click it → Delete), so the new one can take its place.");
      run("/usr/bin/open", ["-a", "Shortcuts"]);
      await pause();
    }
    run("/usr/bin/open", [signed]);
    info(`Shortcuts opened "${name}": click "Add Shortcut".`);
    let added = false;
    for (let i = 0; i < 90 && !added; i++) {
      await k.sleep(2000);
      added = listShortcuts().includes(name);
    }
    if (added) ok(`"${name}" added`);
    else {
      warn(`"${name}" didn't show up. Open ${signed} and click Add Shortcut, then run setup again.`);
      process.exit(1);
    }
  }
  writeFileSync(installedFile, JSON.stringify({ fingerprint, url, at: new Date().toISOString() }) + "\n");

  info("Trying the Alfred Shortcut on this Mac. If macOS asks to let Alfred connect, click Allow.");
  const input = join(shortcutsDir, "test-input.txt");
  writeFileSync(input, "Reply with just the word ready.");
  const test = run("/usr/bin/shortcuts", ["run", "Alfred", "--input-path", input], { timeout: 180_000 });
  if (test.code === 0) ok("The Shortcut reached Alfred and spoke the answer");
  else warn(`The test run didn't finish (${test.err || test.code}). Try running "Alfred" in the Shortcuts app.`);
}
info("On your iPhone (the Shortcuts arrive through iCloud in a minute or so):");
info('  1. Open Shortcuts and run "Alfred" once: allow the microphone/dictation and the connection.');
info("  2. Settings → Accessibility → Vocal Shortcuts → Add Action → Shortcut → Alfred,");
info('     and say "Hey Alfred" three times. Now "Hey Alfred" works without Siri.');
info('  Also works: "Hey Siri, Alfred", the Action Button, Back Tap, and "Type to Alfred" for typing.');

// 13 ─────────────────────────────────────────────────────────────────────────────────────────────
step(13, "Typing to Alfred on the Mac");
const zprofile = join(homedir(), ".zprofile");
const pathLine = `export PATH="${join(ROOT, "bin")}:$PATH" # Alfred`;
if (existsSync(zprofile) && readFileSync(zprofile, "utf8").includes(pathLine)) {
  ok('The "alfred" command is set up');
} else {
  appendFileSync(zprofile, `\n${pathLine}\n`);
  ok('Added the "alfred" command. Open a new Terminal window, then: alfred "what did my partner say last?"');
}

say("\nAlfred is set up. To check on it any time: alfred doctor");
k.done();
process.exit(0);
