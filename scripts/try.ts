// Try commands against Claude without the phone (for Workers AI, use `wrangler dev --remote`):
//   ANTHROPIC_API_KEY=... npm run try -- "skip this song" "text mom I'm running late"
import Anthropic from "@anthropic-ai/sdk";
import { claude, interpret } from "../src/brain.ts";

const think = claude(new Anthropic(), process.env.MODEL);
const now = new Date().toISOString();
for (const text of process.argv.slice(2)) {
  const started = Date.now();
  const reply = await interpret(think, { text, now });
  console.log(`\n> ${text}  (${Date.now() - started} ms)`);
  console.log(JSON.stringify(reply, null, 2));
}
