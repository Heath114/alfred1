// The `alfred` command (bin/alfred): type to Alfred on the Mac. Talks to the running service, so
// it uses the same permissions, model and log as the iPhone does.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const root = join(import.meta.dirname, "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const url = `http://127.0.0.1:${process.env.PORT || 8787}`;

async function ask(text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${url}/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ALFRED_KEY}` },
      body: JSON.stringify({ text, now: localTime(), device: "Mac", wait: true }),
    });
  } catch {
    console.error("Alfred isn't running. Start it with: npm run setup");
    process.exitCode = 1;
    return;
  }
  if (res.status === 401) {
    console.error("Wrong ALFRED_KEY in .env");
    process.exitCode = 1;
    return;
  }
  const reply = (await res.json()) as { say: string };
  console.log(reply.say || "Done.");
}

// "2026-10-22T10:00:00+03:00": the local time with its offset, like the Shortcut sends.
function localTime(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

const words = process.argv.slice(2).join(" ").trim();
if (words) {
  await ask(words);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "alfred> " });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (/^(bye|exit|quit)$/i.test(line)) break;
    if (line) await ask(line);
    rl.prompt();
  }
  rl.close();
}
