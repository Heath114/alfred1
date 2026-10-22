// Telling the owner things when they aren't waiting on the phone: a job that finished after the
// Shortcut already got its answer, a reply that arrived hours later, something that went wrong.
import { execFile } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Note {
  title?: string;
  body: string;
  urgent?: boolean;
}

export type Notify = (note: Note) => Promise<void>;

// Bark (https://bark.day.app): an iOS app plus bark-server, which runs on the Mac and hands
// notifications straight to Apple's push service. The note is encrypted here with a key only the
// phone has (AES-256-GCM), so Apple carries ciphertext and nobody else is involved.
export function bark(opts: { url: string; deviceKey: string; key: string; password?: string }): Notify {
  if (Buffer.byteLength(opts.key) !== 32) throw new Error("BARK_ENCRYPTION_KEY must be exactly 32 characters.");
  return async ({ title, body, urgent }) => {
    const res = await fetch(`${opts.url.replace(/\/$/, "")}/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.password ? { authorization: `Basic ${Buffer.from(`alfred:${opts.password}`).toString("base64")}` } : {}),
      },
      body: JSON.stringify({
        device_key: opts.deviceKey,
        ...encryptForBark(JSON.stringify({ title: title || "Alfred", body, group: "alfred", level: urgent ? "timeSensitive" : "active" }), opts.key),
      }),
    });
    if (!res.ok) throw new Error(`bark ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

// The format the Bark app decrypts (Push Encryption: AES256, GCM): base64 of ciphertext + auth tag,
// and a fresh 12-character IV sent alongside.
export function encryptForBark(plain: string, key: string): { ciphertext: string; iv: string } {
  const iv = randomBytes(6).toString("hex");
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  return { ciphertext, iv };
}

// macOS notifications. terminal-notifier (brew install terminal-notifier) is reliable from a
// background service; `display notification` posts as Script Editor and has been seen to fail
// silently on macOS 26, so it's only the fallback.
export function macNotification(): Notify {
  const notifier = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find((p) => existsSync(p));
  return async ({ title, body }) => {
    if (notifier) {
      await run(notifier, ["-title", title || "Alfred", "-message", body, "-group", "alfred"], { timeout: 10_000 });
    } else {
      await run("osascript", ["-e", "on run {t, b}\ndisplay notification b with title t\nend run", title || "Alfred", body], {
        timeout: 10_000,
      });
    }
  };
}

// Send to every channel; one failing (phone offline, permission missing) doesn't stop the others.
export function everywhere(channels: Notify[], log: (entry: object) => void = () => {}): Notify {
  return async (note) => {
    const results = await Promise.allSettled(channels.map((send) => send(note)));
    for (const r of results) if (r.status === "rejected") log({ notify_failed: String(r.reason) });
  };
}
