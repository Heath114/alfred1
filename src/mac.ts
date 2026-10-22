// macOS hands: Contacts and Messages through AppleScript, message history straight from the Messages
// database, files in the Alfred folder. Needs the permissions in docs/MAC_SETUP.md.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

const SEND = `on run {target, body}
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send body to participant target of svc
  end tell
end run`;

export async function sendMessage(handle: string, text: string): Promise<void> {
  await osascript(SEND, [handle, text]);
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
// NSAttributedString). The string follows the "NSString" class name, length-prefixed.
export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return "";
  let p = at + "NSString".length + 5;
  let length = buf[p];
  p += 1;
  if (length === 0x81) {
    length = buf.readUInt16LE(p);
    p += 2;
  } else if (length === 0x82) {
    length = buf.readUIntLE(p, 3);
    p += 3;
  }
  return buf.subarray(p, p + length).toString("utf8");
}

const APPLE_EPOCH = 978307200; // 2001-01-01 in Unix seconds

export async function readMessages(handles: string[], count: number, dbPath = chatDb()): Promise<Message[]> {
  const db = await openDb(dbPath);
  try {
    const rows = db.prepare("SELECT ROWID AS id, id AS handle FROM handle").all() as { id: number; handle: string }[];
    const ids = rows.filter((r) => handles.some((h) => sameHandle(h, r.handle))).map((r) => r.id);
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
  return new DatabaseSync(dbPath, { readOnly: true });
}

export async function latestMessageId(dbPath = chatDb()): Promise<number> {
  const db = await openDb(dbPath);
  try {
    return Number((db.prepare("SELECT MAX(ROWID) AS id FROM message").get() as { id: number | null }).id ?? 0);
  } finally {
    db.close();
  }
}

// Messages from these handles (not from me) newer than afterId, oldest first.
export async function repliesAfter(handles: string[], afterId: number, dbPath = chatDb()): Promise<(Message & { id: number })[]> {
  const db = await openDb(dbPath);
  try {
    const rows = db.prepare("SELECT ROWID AS id, id AS handle FROM handle").all() as { id: number; handle: string }[];
    const ids = rows.filter((r) => handles.some((h) => sameHandle(h, r.handle))).map((r) => r.id);
    if (!ids.length) return [];
    const found = db
      .prepare(
        `SELECT ROWID AS id, CASE WHEN date > 1000000000000 THEN date / 1000000000 ELSE date END AS secs, text, attributedBody
         FROM message WHERE handle_id IN (${ids.map(() => "?").join(",")}) AND is_from_me = 0
           AND associated_message_type = 0 AND ROWID > ? ORDER BY ROWID`,
      )
      .all(...ids, afterId) as { id: number; secs: number; text: string | null; attributedBody: Uint8Array | null }[];
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
  const path = insideFolder(root, folder, name);
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
