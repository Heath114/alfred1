// macOS hands: Contacts and Messages through AppleScript, message history straight from the Messages
// database, files in the Alfred folder. Needs the permissions in docs/MAC_SETUP.md.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Contact, MacMedia, Message } from "./tools.ts";

const run = promisify(execFile);

async function osascript(script: string, args: string[], language: "AppleScript" | "JavaScript" = "AppleScript") {
  const { stdout } = await run("osascript", ["-l", language, "-e", script, ...args], { timeout: 30_000 });
  return stdout.trim();
}

const FIND_CONTACTS = `function run(argv) {
  const people = Application("Contacts").people.whose({ name: { _contains: argv[0] } })();
  return JSON.stringify(people.slice(0, 10).map((p) => ({
    name: p.name(),
    phones: p.phones().map((x) => x.value()),
    emails: p.emails().map((x) => x.value()),
  })));
}`;

// Contacts are read straight from the AddressBook databases (iCloud and local accounts each have
// one). That's instant and covered by the Full Disk Access Alfred needs anyway; asking the Contacts
// app through AppleScript takes seconds on a big address book and needs another permission, so it's
// only the fallback.
export async function findContacts(name: string, root = join(homedir(), "Library/Application Support/AddressBook")): Promise<Contact[]> {
  const dbs = addressBooks(root);
  if (dbs.length) {
    try {
      return await contactsFromDbs(dbs, name);
    } catch (err) {
      // Locked out of the databases or an unexpected layout: fall through to the Contacts app.
      if (!/authoriz|permission|not permitted|no such (table|column)/i.test(String(err))) throw err;
    }
  }
  return JSON.parse((await osascript(FIND_CONTACTS, [name], "JavaScript")) || "[]");
}

function addressBooks(root: string): string[] {
  const found = [join(root, "AddressBook-v22.abcddb")];
  try {
    for (const source of readdirSync(join(root, "Sources"))) found.push(join(root, "Sources", source, "AddressBook-v22.abcddb"));
  } catch {
    // no Sources folder
  }
  return found.filter((f) => existsSync(f));
}

async function contactsFromDbs(dbs: string[], name: string): Promise<Contact[]> {
  const want = `%${name.toLowerCase()}%`;
  const byKey = new Map<string, Contact>();
  for (const path of dbs) {
    const db = await openDb(path);
    try {
      const people = db
        .prepare(
          `SELECT Z_PK AS id, trim(coalesce(ZFIRSTNAME, '') || ' ' || coalesce(ZLASTNAME, '')) AS full,
             ZNICKNAME AS nick, ZORGANIZATION AS org
           FROM ZABCDRECORD
           WHERE lower(coalesce(ZFIRSTNAME, '') || ' ' || coalesce(ZLASTNAME, '')) LIKE ?
              OR lower(coalesce(ZNICKNAME, '')) LIKE ? OR lower(coalesce(ZORGANIZATION, '')) LIKE ?
           LIMIT 25`,
        )
        .all(want, want, want) as { id: number; full: string; nick: string | null; org: string | null }[];
      for (const p of people) {
        const phones = (db.prepare("SELECT ZFULLNUMBER AS v FROM ZABCDPHONENUMBER WHERE ZOWNER = ?").all(p.id) as { v: string | null }[])
          .map((r) => r.v)
          .filter((v): v is string => Boolean(v));
        const emails = (db.prepare("SELECT ZADDRESS AS v FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?").all(p.id) as { v: string | null }[])
          .map((r) => r.v)
          .filter((v): v is string => Boolean(v));
        const contactName = p.full || p.nick || p.org || "";
        if (!contactName) continue;
        // The same person can be in several accounts; keep one copy with everything.
        const key = contactName.toLowerCase();
        const seen = byKey.get(key);
        if (seen) {
          seen.phones = [...new Set([...seen.phones, ...phones])];
          seen.emails = [...new Set([...seen.emails, ...emails])];
        } else {
          byKey.set(key, { name: contactName, phones, emails });
        }
      }
    } finally {
      db.close();
    }
  }
  return [...byKey.values()].slice(0, 10);
}

// The send script other Messages projects settled on: a participant of the account works for
// people you've never messaged (a chat id doesn't), and errors come back as text saying whether
// the recipient lookup or the send itself failed.
const SEND = `on run argv
  set {h, t, svc} to {item 1 of argv, item 2 of argv, item 3 of argv}
  set phase to "lookup"
  try
    tell application "Messages"
      with timeout of 30 seconds
        if svc is "SMS" then
          set acct to first account whose service type = SMS
        else
          set acct to first account whose service type = iMessage
        end if
        set p to participant h of acct
        set phase to "dispatch"
        send t to p
      end timeout
    end tell
    return "ok"
  on error m number n
    return "err" & tab & phase & tab & n & tab & m
  end try
end run`;

export interface SendOptions {
  runScript?: (args: string[]) => Promise<string>;
  dbPath?: string;
  confirmWithinMs?: number;
}

// Messages can say "sent" and then not send (or write an empty row), so a send only counts once
// the message shows up in the Messages database without an error. iMessage first; SMS (through the
// iPhone's Text Message Forwarding) when the person isn't on iMessage or iMessage fails.
export async function sendMessage(handle: string, text: string, opts: SendOptions = {}): Promise<void> {
  const runScript = opts.runScript ?? ((args) => osascript(SEND, args));
  let lastProblem = "";
  for (const service of ["iMessage", "SMS"]) {
    const before = await latestMessageId(opts.dbPath).catch(() => null);
    const out = await runScript([handle, text, service]);
    if (out.startsWith("err")) {
      const [, phase, code, ...rest] = out.split("\t");
      lastProblem = `${service} ${phase} failed (${code}${rest.length ? `: ${rest.join(" ")}` : ""})`;
      if (code === "-1743") throw new Error("macOS blocked Alfred from controlling Messages. Run: alfred doctor");
      if (phase === "lookup") continue; // not on this service: nothing was sent, try the next
      throw new Error(`Messages couldn't send: ${lastProblem}`);
    }
    if (before === null) return; // can't read the database to confirm; trust Messages
    const row = await sentRow(handle, before, opts.dbPath, opts.confirmWithinMs ?? 10_000);
    if (row === "sent") return;
    if (row === "failed") {
      lastProblem = `${service} delivery failed`;
      continue;
    }
    throw new Error("Messages said it sent, but the message never appeared in Messages. Check the Messages app on the Mac.");
  }
  throw new Error(`Couldn't send to ${handle}: ${lastProblem}.`);
}

// Watch for the outgoing row: "sent" (has text, no error), "failed" (error set), or "missing".
async function sentRow(handle: string, afterId: number, dbPath = chatDb(), withinMs: number): Promise<"sent" | "failed" | "missing"> {
  const until = Date.now() + withinMs;
  do {
    const db = await openDb(dbPath);
    try {
      const ids = handleIds(db, [handle]);
      const rows = ids.length
        ? (db
            .prepare(
              `SELECT error, text, attributedBody FROM message
               WHERE ROWID > ? AND is_from_me = 1 AND handle_id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(afterId, ...ids) as { error: number | null; text: string | null; attributedBody: Uint8Array | null }[])
        : [];
      if (rows.some((r) => r.error)) return "failed";
      if (rows.some((r) => r.text || textFromAttributedBody(r.attributedBody))) return "sent";
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, 400));
  } while (Date.now() < until);
  return "missing";
}

// Phone numbers are stored differently in Contacts ("079 123 4567") and Messages ("+962791234567"),
// so compare the last 9 digits.
export function sameHandle(a: string, b: string): boolean {
  if (a.includes("@") || b.includes("@")) return a.toLowerCase() === b.toLowerCase();
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  return da.length >= 7 && db.length >= 7 && da.slice(-9) === db.slice(-9);
}

// Newer macOS keeps the text of most messages only inside attributedBody (an archived
// NSAttributedString). After the "NSString" class name comes the marker 01 2B, then the length
// (one byte, or 0x81 + 16-bit, or 0x82 + 32-bit, little-endian), then the UTF-8 text.
export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return "";
  const marker = buf.indexOf(Buffer.from([0x01, 0x2b]), at + 8);
  if (marker < 0 || marker > at + 8 + 16) return "";
  let p = marker + 2;
  let length = buf[p];
  p += 1;
  if (length === 0x81) {
    length = buf.readUInt16LE(p);
    p += 2;
  } else if (length === 0x82) {
    length = buf.readUInt32LE(p);
    p += 4;
  }
  return buf.subarray(p, p + length).toString("utf8");
}

const APPLE_EPOCH = 978307200; // 2001-01-01 in Unix seconds

export async function readMessages(handles: string[], count: number, dbPath = chatDb()): Promise<Message[]> {
  const db = await openDb(dbPath);
  try {
    const ids = handleIds(db, handles);
    if (!ids.length) return [];
    const messages = db
      .prepare(
        // date is nanoseconds since 2001 on current macOS (too big for a JS number), seconds on very
        // old databases; convert in SQL.
        `SELECT is_from_me, CASE WHEN date > 1000000000000 THEN date / 1000000000 ELSE date END AS secs,
           text, attributedBody FROM message
         WHERE handle_id IN (${ids.map(() => "?").join(",")}) AND associated_message_type = 0
         ORDER BY date DESC LIMIT ?`,
      )
      .all(...ids, count) as { is_from_me: number; secs: number; text: string | null; attributedBody: Uint8Array | null }[];
    return messages.reverse().map((m) => ({
      from: m.is_from_me ? "me" : "them",
      text: m.text || textFromAttributedBody(m.attributedBody) || "(attachment)",
      at: new Date((m.secs + APPLE_EPOCH) * 1000).toISOString(),
    }));
  } finally {
    db.close();
  }
}

const chatDb = () => join(homedir(), "Library/Messages/chat.db");

async function openDb(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  // Read-only, and wait briefly if Messages is writing. Never immutable=1: it misses recent writes.
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
}

type Db = Awaited<ReturnType<typeof openDb>>;

function handleIds(db: Db, handles: string[]): number[] {
  const rows = db.prepare("SELECT ROWID AS id, id AS handle FROM handle").all() as { id: number; handle: string }[];
  return rows.filter((r) => handles.some((h) => sameHandle(h, r.handle))).map((r) => r.id);
}

// Why Messages can't be read: no Full Disk Access (macOS refuses even to look at the folder),
// or Messages was never set up on this Mac.
export function messagesProblem(dbPath = chatDb()): string | null {
  try {
    statSync(dbPath);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "Messages isn't set up on this Mac: open Messages and sign in with your Apple Account.";
    if (code === "EPERM" || code === "EACCES") return "no Full Disk Access";
    return String(err);
  }
}

export async function latestMessageId(dbPath = chatDb()): Promise<number> {
  const problem = messagesProblem(dbPath);
  if (problem) throw new Error(problem);
  const db = await openDb(dbPath);
  try {
    return Number((db.prepare("SELECT MAX(ROWID) AS id FROM message").get() as { id: number | null }).id ?? 0);
  } finally {
    db.close();
  }
}

// Messages from these handles (not from me) newer than afterId, oldest first. `since` also drops
// old messages that an iCloud resync re-inserts with new row ids.
export async function repliesAfter(handles: string[], afterId: number, since?: string, dbPath = chatDb()): Promise<(Message & { id: number })[]> {
  const db = await openDb(dbPath);
  try {
    const ids = handleIds(db, handles);
    if (!ids.length) return [];
    const sinceSecs = since ? Date.parse(since) / 1000 - APPLE_EPOCH - 120 : -Infinity;
    const found = (db
      .prepare(
        `SELECT ROWID AS id, CASE WHEN date > 1000000000000 THEN date / 1000000000 ELSE date END AS secs, text, attributedBody
         FROM message WHERE handle_id IN (${ids.map(() => "?").join(",")}) AND is_from_me = 0
           AND associated_message_type = 0 AND ROWID > ? ORDER BY ROWID`,
      )
      .all(...ids, afterId) as { id: number; secs: number; text: string | null; attributedBody: Uint8Array | null }[])
      .filter((m) => m.secs >= sinceSecs);
    return found.map((m) => ({
      id: m.id,
      from: "them",
      text: m.text || textFromAttributedBody(m.attributedBody) || "(attachment)",
      at: new Date((m.secs + APPLE_EPOCH) * 1000).toISOString(),
    }));
  } finally {
    db.close();
  }
}

// Files stay inside the Alfred folder, whatever path the model asks for.
export function insideFolder(root: string, folder: string, name: string): string {
  const base = resolve(root);
  const path = resolve(base, folder || ".", name);
  if (!name || (path !== base && !path.startsWith(base + sep))) throw new Error("File must stay inside the Alfred folder.");
  return path;
}

export async function saveFile(root: string, folder: string, name: string, content: string): Promise<string> {
  const path = insideFolder(root, folder, /\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.txt`);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : content + "\n");
  return path;
}

export async function openApp(name: string): Promise<void> {
  await run("open", ["-a", name], { timeout: 15_000 });
}

async function isRunning(app: string): Promise<boolean> {
  try {
    await run("pgrep", ["-x", app]);
    return true;
  } catch {
    return false;
  }
}

// Music on the Mac itself. Checking with pgrep first matters: an AppleScript that names an app
// that isn't installed won't even compile, and asking a closed player to "pause" would launch it.
export async function macMedia(action: MacMedia, level: number): Promise<string> {
  if (action === "volume") {
    await osascript(`set volume output volume ${Math.round(level)}`, []);
    return `Mac volume ${Math.round(level)}`;
  }
  const app = (await isRunning("Spotify")) ? "Spotify" : (await isRunning("Music")) ? "Music" : null;
  if (!app) throw new Error("Nothing is playing on the Mac: Spotify and Music are both closed.");
  const verb = { next: "next track", previous: "previous track", pause: "pause", play: "play" }[action];
  await osascript(`tell application "${app}" to ${verb}`, []);
  return `${app}: ${verb}`;
}

// Reminders on the Mac sync to the iPhone through iCloud and alert there. The date is built from
// numbers, so it doesn't depend on the Mac's date format.
const ADD_REMINDER = `on run argv
  set t to item 1 of argv
  tell application "Reminders"
    if (count of argv) > 1 then
      set dt to current date
      set day of dt to 1
      set year of dt to (item 2 of argv) as integer
      set month of dt to (item 3 of argv) as integer
      set day of dt to (item 4 of argv) as integer
      set hours of dt to (item 5 of argv) as integer
      set minutes of dt to (item 6 of argv) as integer
      set seconds of dt to 0
      make new reminder with properties {name:t, remind me date:dt}
    else
      make new reminder with properties {name:t}
    end if
  end tell
end run`;

export function reminderArgs(text: string, when: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(when);
  return m ? [text, ...m.slice(1).map((n) => String(Number(n)))] : [text];
}

export async function addReminder(text: string, when: string): Promise<void> {
  await osascript(ADD_REMINDER, reminderArgs(text, when));
}

// Setup asks the running service to do one harmless thing with Messages and Reminders, so macOS
// shows its "Alfred wants to control..." prompt for the right program while the owner is watching.
const PROBES = {
  messages: `tell application id "com.apple.MobileSMS" to count accounts`,
  reminders: `tell application id "com.apple.reminders" to count lists`,
};

export async function probeAutomation(app: keyof typeof PROBES): Promise<void> {
  try {
    await run("osascript", ["-e", "with timeout of 300 seconds", "-e", PROBES[app], "-e", "end timeout"], { timeout: 310_000 });
  } catch (err) {
    const text = String((err as { stderr?: string }).stderr || err);
    if (/-1743|not allowed|Not authori[sz]ed/i.test(text)) throw new Error("not allowed");
    throw new Error(text.trim().slice(0, 200));
  }
}
