// Try commands against the real API without the phone:
//   ANTHROPIC_API_KEY=... npm run try -- "skip this song" "text mom I'm running late"
import Anthropic from "@anthropic-ai/sdk";
import { interpret } from "../src/brain.ts";

const client = new Anthropic();
const now = new Date().toISOString();
for (const text of process.argv.slice(2)) {
  const started = Date.now();
  const reply = await interpret(client, { text, now }, process.env.MODEL);
  console.log(`\n> ${text}  (${Date.now() - started} ms)`);
  console.log(JSON.stringify(reply, null, 2));
}
