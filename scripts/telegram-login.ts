// Log Alfred into your Telegram account again (setup does this the first time).
import { createInterface } from "node:readline/promises";
import { SESSION_FILE, telegramLogin } from "../src/telegram.ts";

const { TELEGRAM_API_ID, TELEGRAM_API_HASH } = process.env;
if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.error("Put TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org) in .env first.");
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
await telegramLogin(Number(TELEGRAM_API_ID), TELEGRAM_API_HASH, (q) => rl.question(q));
rl.close();
console.log(`Logged in. Session saved to ${SESSION_FILE}`);
process.exit(0);
