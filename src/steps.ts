// Everything the iPhone Shortcut knows how to do. Each one is a branch in the Shortcut
// (docs/SHORTCUT.md), so adding an action here means adding a branch there too.
export const ACTIONS = [
  "next", // skip to the next track, in whatever app is playing
  "previous", // previous track / restart
  "pause",
  "play",
  "volume", // value: 0-100
  "brightness", // value: 0-100
  "flashlight", // text: "on" | "off"
  "focus", // Do Not Disturb. text: "on" | "off"
  "timer", // value: seconds
  "alarm", // text: "HH:MM", 24h
  "reminder", // text: what, when: "YYYY-MM-DD HH:MM" or ""
  "message", // who: contact name, text: the message
  "call", // who: contact name
  "open", // url: app URL scheme or https link
] as const;

export type Action = (typeof ACTIONS)[number];

// Every field is always present so the Shortcut never has to check for a missing key.
export interface Step {
  do: Action;
  value: number;
  level: number; // value as 0-1, for the Shortcut's Set Volume / Set Brightness
  text: string;
  who: string;
  url: string;
  when: string;
}

export interface Reply {
  say: string;
  steps: Step[];
}

export interface Command {
  text: string;
  // The phone's local time, e.g. "2026-10-21T14:05:00+03:00". Needed for alarms and reminders.
  now?: string;
  // Where the command came from: "iPhone"/"iPad" (Shortcut), "Mac" (Shortcut or the alfred command).
  device?: string;
  // The alfred command waits for the whole job; the Shortcut gets an early answer instead.
  wait?: boolean;
}

export type Device = "phone" | "mac";

export function deviceOf(device?: string): Device {
  return /mac|cli/i.test(device ?? "") ? "mac" : "phone";
}

// Keeps numbers in range and drops anything unexpected, because the Shortcut acts on the phone
// without asking.
export function clean(raw: Reply): Reply {
  if (typeof raw !== "object" || raw === null) throw new Error("reply is not an object");
  const steps = (raw.steps ?? [])
    .filter((s) => (ACTIONS as readonly string[]).includes(s.do))
    .map((s) => {
      let value = Number.isFinite(s.value) ? s.value : 0;
      if (s.do === "volume" || s.do === "brightness") value = Math.min(100, Math.max(0, Math.round(value)));
      if (s.do === "timer") value = Math.max(0, Math.round(value));
      let url = s.url ?? "";
      // Smaller models sometimes put the link in text; the Shortcut only opens url.
      if (s.do === "open" && !url && /^[a-z][a-z0-9+.-]*:/i.test(s.text ?? "")) url = s.text;
      return {
        do: s.do,
        value,
        level: s.do === "volume" || s.do === "brightness" ? value / 100 : 0,
        text: s.text ?? "",
        who: s.who ?? "",
        url,
        when: s.when ?? "",
      };
    });
  return { say: raw.say ?? "", steps };
}
