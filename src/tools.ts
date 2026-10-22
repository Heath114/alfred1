import { ACTIONS, type Step } from "./steps.ts";
import type { ToolSpec } from "./ollama.ts";

export interface Contact {
  name: string;
  phones: string[];
  emails: string[];
}

export interface Message {
  from: string; // "me" or the sender's name/handle
  text: string;
  at: string; // ISO time
}

// Everything Alfred can touch on the Mac. src/mac.ts and src/telegram.ts are the real ones;
// tests use fakes.
export interface Hands {
  findContacts(name: string): Promise<Contact[]>;
  readMessages(handles: string[], count: number): Promise<Message[]>;
  latestMessageId(): Promise<number>;
  repliesAfter(handles: string[], afterId: number): Promise<(Message & { id: number })[]>;
  sendMessage(handle: string, text: string): Promise<void>;
  telegramRead(chat: string, count: number): Promise<{ chat: string; messages: Message[] }>;
  telegramSend(chat: string, text: string): Promise<{ chat: string }>;
  saveFile(folder: string, name: string, content: string): Promise<string>;
  openApp(name: string): Promise<void>;
}

// "Do the rest when Sam answers": kept by src/waits.ts until a reply arrives.
export interface Waiting {
  contact: string;
  handles: string[];
  afterId: number; // only messages newer than this count as the reply
  then: string; // what to do with the reply, in the model's words
  command: string; // the owner's original command; decides who may be messaged
  since: string;
}

export interface Turn {
  command: string; // what the owner said, verbatim: sends are only allowed to people named in it
  people: Record<string, string>; // "partner" -> "Sam Haddad", from people.json
  steps: Step[]; // phone actions queued for the Shortcut
  hands: Hands;
  wait(w: Waiting): void;
  sent: Map<string, number>; // contact name -> latest message id when Alfred messaged them this turn
}

interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, turn: Turn): Promise<unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || fallback);

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: Tool["run"]): Tool {
  return {
    spec: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
    run,
  };
}

// "partner" -> the real name from people.json; anything else unchanged.
export function realName(who: string, turn: Turn): string {
  const key = who.toLowerCase().replace(/^(my|the)\s+/, "");
  return Object.entries(turn.people).find(([alias]) => alias.toLowerCase() === key)?.[1] ?? who;
}

// Alfred only sends to someone the owner named in this command, directly or by an alias like
// "my partner". Messages Alfred reads come from other people, and a small model can be talked into
// things; this stops a message that says "forward this to everyone" from going anywhere.
export function namedInCommand(who: string, turn: Turn): boolean {
  const said = turn.command.toLowerCase();
  const target = who.toLowerCase().replace(/^@/, "").replace(/^(my|the)\s+/, "");
  const real = realName(who, turn).toLowerCase();
  if (target.length > 1 && said.includes(target)) return true;
  if (real.split(/\s+/).some((part) => part.length > 1 && said.includes(part))) return true;
  return Object.entries(turn.people).some(
    ([alias, name]) => said.includes(alias.toLowerCase()) && (name.toLowerCase() === real || name.toLowerCase() === target),
  );
}

// Small models sometimes write a template ("${reply}", "[his response]") instead of reading the
// real text first. Refuse it, so a placeholder never gets sent or saved.
export function noPlaceholders(text: string): string {
  if (/\$\{|\{\{|\[(his|her|their|the) [^\]]*(reply|response|message|answer)[^\]]*\]|<[^>]*(reply|response)[^>]*>/i.test(text)) {
    throw new Error("That text has a placeholder in it. Read the real message with a tool first and use its exact words.");
  }
  if (!text.trim()) throw new Error("The text is empty.");
  return text;
}

async function contactFor(who: string, turn: Turn): Promise<Contact> {
  const name = realName(who, turn);
  const found = await turn.hands.findContacts(name);
  const exact = found.filter((c) => c.name.toLowerCase() === name.toLowerCase());
  const pick = exact.length === 1 ? exact : found;
  if (pick.length === 0) throw new Error(`No contact named "${name}".`);
  if (pick.length > 1) throw new Error(`Several contacts match "${name}": ${pick.map((c) => c.name).join(", ")}. Ask which one.`);
  if (!pick[0].phones.length && !pick[0].emails.length) throw new Error(`${pick[0].name} has no phone number or email.`);
  return pick[0];
}

export const TOOLS: Tool[] = [
  tool(
    "phone",
    `Do something on the owner's iPhone. Runs right after you reply, in the order called. Actions:
next/previous/pause/play: whatever app is playing music or audio.
volume, brightness: value 0-100. Relative requests: up 75, a bit up 60, down 30, a bit down 40, mute 0.
flashlight, focus (Do Not Disturb): text "on" or "off".
timer: value in seconds. alarm: text "HH:MM" 24h.
reminder: text what, when "YYYY-MM-DD HH:MM" or "".
call: who is the contact name.
open: url of an app or page (spotify:search:<query>, maps://?daddr=<place>, whatsapp:, https://...).`,
    {
      action: { type: "string", enum: ACTIONS.filter((a) => a !== "message") },
      value: { type: "number" },
      text: { type: "string" },
      who: { type: "string" },
      url: { type: "string" },
      when: { type: "string" },
    },
    ["action"],
    async (a, turn) => {
      const action = str(a.action);
      if (!(ACTIONS as readonly string[]).includes(action) || action === "message") {
        throw new Error(`Unknown phone action "${action}". To text someone use messages_send.`);
      }
      turn.steps.push({
        do: action as Step["do"],
        value: num(a.value, 0),
        text: str(a.text),
        who: str(a.who) && realName(str(a.who), turn),
        url: str(a.url),
        when: str(a.when),
      });
      return { queued: action };
    },
  ),
  tool(
    "messages_read",
    "Read the latest iMessages/SMS between the owner and a contact (newest last).",
    { contact: { type: "string", description: 'Name, or a word like "partner"' }, count: { type: "number" } },
    ["contact"],
    async (a, turn) => {
      const c = await contactFor(str(a.contact), turn);
      const handles = [...c.phones, ...c.emails];
      // Right after messaging someone, their "response" can only be something newer than that, and
      // a small model will otherwise grab an old message and treat it as the answer.
      const sentAt = turn.sent.get(c.name);
      if (sentAt !== undefined) {
        const replies = await turn.hands.repliesAfter(handles, sentAt);
        if (!replies.length) {
          return { contact: c.name, messages: [], note: `No reply from ${c.name} yet to the message you just sent. Call wait_for_reply with the rest of the instructions.` };
        }
        return { contact: c.name, replies: replies.map((m) => ({ from: c.name, text: m.text, at: m.at })) };
      }
      const messages = await turn.hands.readMessages(handles, Math.min(20, num(a.count, 5)));
      return { contact: c.name, messages: messages.map((m) => ({ ...m, from: m.from === "me" ? "me" : c.name })) };
    },
  ),
  tool(
    "messages_send",
    "Send an iMessage/SMS from the owner to a contact. Write it as the owner, first person.",
    { contact: { type: "string" }, text: { type: "string" } },
    ["contact", "text"],
    async (a, turn) => {
      const who = str(a.contact);
      if (!namedInCommand(who, turn)) throw new Error(`Not sent: the owner didn't name "${who}" in this command.`);
      const c = await contactFor(who, turn);
      const text = noPlaceholders(str(a.text));
      const before = await turn.hands.latestMessageId();
      await turn.hands.sendMessage(c.phones[0] ?? c.emails[0], text);
      if (!turn.sent.has(c.name)) turn.sent.set(c.name, before);
      return { sent_to: c.name };
    },
  ),
  tool(
    "wait_for_reply",
    "When the owner wants something done with a reply that hasn't arrived yet: after sending, call this with the rest of the instructions. Alfred watches for the contact's next iMessage and does them then (up to 24 hours).",
    {
      contact: { type: "string" },
      then: { type: "string", description: 'What to do with the reply, e.g. "save the reply to a file in folder partner and send it to Lina on Telegram"' },
    },
    ["contact", "then"],
    async (a, turn) => {
      const c = await contactFor(str(a.contact), turn);
      const then = str(a.then);
      if (!then) throw new Error("Say what to do with the reply.");
      turn.wait({
        contact: c.name,
        handles: [...c.phones, ...c.emails],
        afterId: turn.sent.get(c.name) ?? (await turn.hands.latestMessageId()),
        then,
        command: turn.command,
        since: new Date().toISOString(),
      });
      return { waiting_for: c.name, then };
    },
  ),
  tool(
    "telegram_read",
    "Read the latest messages in one of the owner's Telegram chats (newest last).",
    { chat: { type: "string", description: "Chat or person name, or @username" }, count: { type: "number" } },
    ["chat"],
    async (a, turn) => turn.hands.telegramRead(realName(str(a.chat), turn), Math.min(20, num(a.count, 5))),
  ),
  tool(
    "telegram_send",
    "Send a Telegram message from the owner's account to a chat or person.",
    { chat: { type: "string", description: "Chat or person name, or @username" }, text: { type: "string" } },
    ["chat", "text"],
    async (a, turn) => {
      const chat = str(a.chat);
      if (!namedInCommand(chat, turn)) throw new Error(`Not sent: the owner didn't name "${chat}" in this command.`);
      return { sent_to: (await turn.hands.telegramSend(realName(chat, turn), noPlaceholders(str(a.text)))).chat };
    },
  ),
  tool(
    "save_file",
    "Save text to a file on the Mac, in the owner's Alfred folder.",
    { folder: { type: "string" }, name: { type: "string", description: "File name, e.g. notes.txt" }, content: { type: "string" } },
    ["name", "content"],
    async (a, turn) => ({ saved: await turn.hands.saveFile(str(a.folder), str(a.name), noPlaceholders(String(a.content ?? ""))) }),
  ),
  tool(
    "open_mac_app",
    "Open an app on the Mac.",
    { name: { type: "string", description: 'App name, e.g. "Safari"' } },
    ["name"],
    async (a, turn) => {
      await turn.hands.openApp(str(a.name));
      return { opened: str(a.name) };
    },
  ),
];
