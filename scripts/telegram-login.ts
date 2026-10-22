// One-time login to your own Telegram account. Saves the session to ~/.alfred/telegram.session
// (readable only by you); Alfred uses it to read and send as you.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import tg from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { SESSION_FILE } from "../src/telegram.ts";

const { TELEGRAM_API_ID, TELEGRAM_API_HASH } = process.env;
if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.error("Put TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org) in .env first.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new tg.TelegramClient(new StringSession(""), Number(TELEGRAM_API_ID), TELEGRAM_API_HASH, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => rl.question("Phone number (with country code, e.g. +962...): "),
  phoneCode: () => rl.question("Code Telegram sent you: "),
  password: () => rl.question("Two-step verification password (empty if none): "),
  onError: (err) => console.error(err.message),
});
await mkdir(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
await writeFile(SESSION_FILE, String(client.session.save()), { mode: 0o600 });
console.log(`Logged in. Session saved to ${SESSION_FILE}`);
rl.close();
await client.disconnect();
process.exit(0);
