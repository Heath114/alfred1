// Telling the owner things when they aren't waiting on the phone: a job that finished after the
// Shortcut already got its answer, a reply that arrived hours later, something that went wrong.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Note {
  title?: string;
  body: string;
  urgent?: boolean;
}

export type Notify = (note: Note) => Promise<void>;

// ntfy (https://ntfy.sh), self-hosted on the Mac. The iPhone's ntfy app is subscribed to the topic
// through Tailscale; content stays on the Mac (see docs/MAC_SETUP.md).
export function ntfy(baseUrl: string, topic: string, token?: string): Notify {
  return async ({ title, body, urgent }) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        ...(title ? { Title: encodeHeader(title) } : {}),
        Priority: urgent ? "high" : "default",
        Tags: "tophat",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

// HTTP headers are Latin-1; ntfy accepts RFC 2047 encoded words for anything else (emoji, Arabic).
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

export function macNotification(): Notify {
  return async ({ title, body }) => {
    await run("osascript", ["-e", "on run {t, b}\ndisplay notification b with title t\nend run", title || "Alfred", body], {
      timeout: 10_000,
    });
  };
}

// Send to every channel; one failing (phone offline, permission missing) doesn't stop the others.
export function everywhere(channels: Notify[], log: (entry: object) => void = () => {}): Notify {
  return async (note) => {
    const results = await Promise.allSettled(channels.map((send) => send(note)));
    for (const r of results) if (r.status === "rejected") log({ notify_failed: String(r.reason) });
  };
}
