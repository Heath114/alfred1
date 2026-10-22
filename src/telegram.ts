// The owner's own Telegram account, through Telegram's official client API (MTProto via GramJS).
// The login session lives only on this Mac (~/.alfred/telegram.session), created during setup.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import tg from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { paths } from "./paths.ts";
import type { Message } from "./tools.ts";

export const SESSION_FILE = join(paths.state, "telegram.session");

type Client = InstanceType<typeof tg.TelegramClient>;

export function telegram(apiId: number, apiHash: string) {
  let client: Promise<Client> | undefined;

  async function connect(): Promise<Client> {
    const session = await readFile(SESSION_FILE, "utf8").catch(() => {
      throw new Error("Telegram isn't set up on the Mac yet (run setup again).");
    });
    const c = new tg.TelegramClient(new StringSession(session.trim()), apiId, apiHash, { connectionRetries: 3 });
    await c.connect();
    return c;
  }

  // "@name" is a username; anything else is matched against chat titles and people's names.
  async function find(chat: string) {
    const c = await (client ??= connect().catch((err) => ((client = undefined), Promise.reject(err))));
    if (chat.startsWith("@")) {
      const entity = await c.getEntity(chat);
      return { c, entity, title: chat };
    }
    const want = chat.toLowerCase();
    const matches = [];
    for await (const d of c.iterDialogs({ limit: 300 })) {
      const title = (d.title ?? d.name ?? "").toLowerCase();
      if (title === want) return { c, entity: d.entity!, title: d.title ?? chat };
      if (title.includes(want)) matches.push(d);
    }
    if (matches.length === 1) return { c, entity: matches[0].entity!, title: matches[0].title ?? chat };
    if (!matches.length) throw new Error(`No Telegram chat matches "${chat}".`);
    throw new Error(`Several Telegram chats match "${chat}": ${matches.slice(0, 5).map((d) => d.title).join(", ")}. Ask which one.`);
  }

  return {
    async read(chat: string, count: number): Promise<{ chat: string; messages: Message[] }> {
      const { c, entity, title } = await find(chat);
      const list = await c.getMessages(entity, { limit: count });
      return {
        chat: title,
        messages: list.reverse().map((m) => ({
          from: m.out ? "me" : title,
          text: m.message || "(media)",
          at: new Date(m.date * 1000).toISOString(),
        })),
      };
    },
    async send(chat: string, text: string): Promise<{ chat: string }> {
      const { c, entity, title } = await find(chat);
      await c.sendMessage(entity, { message: text });
      return { chat: title };
    },
  };
}
