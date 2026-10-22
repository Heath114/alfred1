// Dry run: the real local model plans the command, but nothing is sent or saved. Pretend hands
// print each action instead, with made-up contacts and conversations.
//   npm run try -- "reply to my partner saying I'm on my way"
import { runAgent } from "../src/agent.ts";
import { configFromEnv } from "../src/server.ts";
import type { Hands } from "../src/tools.ts";

const show = (what: string) => console.log(`   → ${what}`);
const pretend: Hands = {
  findContacts: async (name) =>
    [
      { name: "Sam Haddad", phones: ["+962791112222"], emails: [] },
      { name: "Lina Odeh", phones: ["+962793334444"], emails: [] },
      { name: "Mom", phones: ["+962795556666"], emails: [] },
    ].filter((c) => c.name.toLowerCase().includes(name.toLowerCase())),
  readMessages: async () => [
    { from: "me", text: "can you grab the keys from my desk on your way?", at: "2026-10-22T09:00:00Z" },
    { from: "them", text: "Sure, I'll pick them up at 6 and be home by 7", at: "2026-10-22T09:05:00Z" },
  ],
  latestMessageId: async () => 100,
  repliesAfter: async () => [],
  sendMessage: async (handle, text) => show(`iMessage to ${handle}: ${text}`),
  telegramRead: async (chat) => ({ chat, messages: [{ from: chat, text: "Did Sam answer?", at: "2026-10-22T09:10:00Z" }] }),
  telegramSend: async (chat, text) => (show(`Telegram to ${chat}: ${text}`), { chat }),
  saveFile: async (folder, name, content) => (show(`save ~/Alfred/${folder}/${name}: ${content}`), `~/Alfred/${folder}/${name}`),
  openApp: async (name) => show(`open ${name}`),
};

const { chat } = configFromEnv({ ...process.env, ALFRED_KEY: process.env.ALFRED_KEY || "dry-run" });
const people = { partner: "Sam Haddad" };
for (const text of process.argv.slice(2)) {
  console.log(`\n> ${text}`);
  const started = Date.now();
  const reply = await runAgent({ text, now: new Date().toISOString() }, { chat, hands: pretend, people, log: (e: any) => e.error && show(`(${e.tool} refused: ${e.error})`), onWait: (w) => show(`wait for ${w.contact}'s reply, then: ${w.then}`) });
  for (const s of reply.steps) show(`phone: ${s.do}${s.value ? ` ${s.value}` : ""}${s.text ? ` "${s.text}"` : ""}${s.who ? ` ${s.who}` : ""}${s.url ? ` ${s.url}` : ""}`);
  console.log(`   says: ${JSON.stringify(reply.say)}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}
