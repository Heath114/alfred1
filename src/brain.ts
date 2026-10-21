import type Anthropic from "@anthropic-ai/sdk";

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
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say", "steps"],
  properties: {
    say: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["do", "value", "text", "who", "url", "when"],
        properties: {
          do: { type: "string", enum: [...ACTIONS] },
          value: { type: "number" },
          text: { type: "string" },
          who: { type: "string" },
          url: { type: "string" },
          when: { type: "string" },
        },
      },
    },
  },
};

export const SYSTEM = `You are Alfred, the owner's voice assistant on their iPhone. They spoke a command; \
you turn it into steps an iOS Shortcut will run, and a short spoken reply.

Steps (every field is required; use 0 or "" for fields an action does not use):
- next / previous / pause / play: controls whatever app is playing audio (Spotify, Apple Music, YouTube, podcasts...).
- volume, brightness: value is 0-100. The phone cannot read the current level, so for relative requests pick: \
"up"/"louder" 75, "a bit louder" 60, "down"/"quieter" 30, "a bit quieter" 40, "mute" 0, "max" 100.
- flashlight, focus (Do Not Disturb): text is "on" or "off".
- timer: value is the duration in seconds.
- alarm: text is the time as "HH:MM" in 24h.
- reminder: text is what to remember; when is "YYYY-MM-DD HH:MM" local time, or "" if no time was given.
- message: who is the contact name as spoken ("Mom", "Omar"); text is the message, written as the owner would \
send it (first person, fix dictation errors, no quotes).
- call: who is the contact name.
- open: url opens an app or page. Use app URL schemes: spotify:, music:, youtube:, whatsapp:, instagram:, \
twitter:, snapchat:, tiktok:, mailto:, sms:, photos-redirect:, calshow:, mobilenotes:, x-apple-reminderkit:, \
shortcuts:, clock-alarm:, App-prefs: (Settings). Directions: maps://?daddr=<place, url-encoded>. \
Play something on Spotify: spotify:search:<query, url-encoded>. Search the web: https://www.google.com/search?q=<query>.

Rules:
- One command can need several steps ("pause and set a timer for 10 minutes" is two steps, in order).
- Dictation is imperfect: read through misheard words to the obvious intent ("skip the song", "next one", \
"I don't like this" all mean next).
- say is spoken aloud over whatever is playing, so keep it short. Leave it "" for media, volume and other \
obvious instant actions. Confirm messages, calls, alarms, timers and reminders in a few words. \
If they asked a question, answer it in one or two sentences with no steps.
- Never invent a contact, number or time. If the command is unclear or nothing above can do it, return no \
steps and say so briefly ("I can't do that yet." / "Sorry, say that again?").
- Current local time: given in the message. Use it for "tonight", "in 20 minutes", "tomorrow at 7".`;

// Something that answers SYSTEM + a user message with JSON matching SCHEMA (parsed or as text).
export type Think = (system: string, user: string) => Promise<unknown>;

export const CLAUDE_MODEL = "claude-opus-5-5";
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export async function interpret(think: Think, cmd: Command): Promise<Reply> {
  const text = cmd.text.trim();
  if (!text) return { say: "Sorry, I didn't catch that.", steps: [] };
  const out = await think(SYSTEM, `Local time: ${cmd.now || "unknown"}\nCommand: ${text}`);
  return clean(typeof out === "string" ? JSON.parse(out) : (out as Reply));
}

// Cloudflare Workers AI: runs on the Cloudflare account, no other key needed.
export function workersAi(ai: Ai, model = WORKERS_AI_MODEL): Think {
  return async (system, user) => {
    const result = (await ai.run(model as any, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_tokens: 1024,
      temperature: 0,
    } as any)) as { response?: unknown };
    if (result?.response == null) throw new Error("Workers AI returned no response");
    return result.response;
  };
}

// Claude, when ANTHROPIC_API_KEY is set: better at messy dictation and multi-step commands.
export function claude(client: Anthropic, model = CLAUDE_MODEL): Think {
  return async (system, user) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2048,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Voice is latency-bound: these are short, well-specified mappings.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") return { say: "I can't help with that.", steps: [] };
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error(`no text in response (stop_reason ${response.stop_reason})`);
    return block.text;
  };
}

// The schema already constrains the shape; this keeps numbers in range and drops anything unexpected,
// because the Shortcut acts on the phone without asking.
export function clean(raw: Reply): Reply {
  if (typeof raw !== "object" || raw === null) throw new Error("reply is not an object");
  const steps = (raw.steps ?? [])
    .filter((s) => (ACTIONS as readonly string[]).includes(s.do))
    .map((s) => {
      let value = Number.isFinite(s.value) ? s.value : 0;
      if (s.do === "volume" || s.do === "brightness") value = Math.min(100, Math.max(0, Math.round(value)));
      if (s.do === "timer") value = Math.max(0, Math.round(value));
      return {
        do: s.do,
        value,
        text: s.text ?? "",
        who: s.who ?? "",
        url: s.url ?? "",
        when: s.when ?? "",
      };
    });
  return { say: raw.say ?? "", steps };
}
