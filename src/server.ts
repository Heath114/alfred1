// Alfred on the Mac mini. Listens on localhost only; `tailscale serve` puts it on your tailnet
// with HTTPS so only your own devices can reach it (docs/MAC_SETUP.md).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.ts";
import * as mac from "./mac.ts";
import { ollama, openaiCompatible, type Chat } from "./ollama.ts";
import type { Command } from "./steps.ts";
import { telegram } from "./telegram.ts";
import type { Hands } from "./tools.ts";

export interface Config {
  key: string;
  folder: string; // where Alfred saves files, people.json and its log
  chat: Chat;
  hands: Hands;
}

export function configFromEnv(env = process.env): Config {
  if (!env.ALFRED_KEY) throw new Error("Set ALFRED_KEY in .env (the password the Shortcut sends).");
  const folder = env.ALFRED_FOLDER || join(homedir(), "Alfred");
  const tgApi = env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH ? telegram(Number(env.TELEGRAM_API_ID), env.TELEGRAM_API_HASH) : null;
  const noTelegram = async (): Promise<never> => {
    throw new Error("Telegram isn't set up (TELEGRAM_API_ID and TELEGRAM_API_HASH in .env).");
  };
  return {
    key: env.ALFRED_KEY,
    folder,
    // MODEL_URL points at an OpenAI-style local server (LM Studio etc.); without it, Ollama.
    chat: env.MODEL_URL ? openaiCompatible(env.MODEL || "qwen3-8b", env.MODEL_URL) : ollama(env.MODEL || "qwen3:8b", env.OLLAMA_HOST),
    hands: {
      findContacts: mac.findContacts,
      readMessages: (handles, count) => mac.readMessages(handles, count),
      sendMessage: mac.sendMessage,
      telegramRead: tgApi ? tgApi.read : noTelegram,
      telegramSend: tgApi ? tgApi.send : noTelegram,
      saveFile: (dir, name, content) => mac.saveFile(folder, dir, name, content),
      openApp: mac.openApp,
    },
  };
}

// people.json maps what you call someone to their name in Contacts: {"partner": "Sam Haddad"}.
// Read on every command so edits apply without a restart.
async function people(folder: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(folder, "people.json"), "utf8"));
  } catch {
    return {};
  }
}

export function handler(config: Config) {
  const log = (entry: object) =>
    appendFile(join(config.folder, "alfred.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n").catch(() => {});

  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/") return send(200, { ok: true, name: "alfred" });
    if (req.method !== "POST" || req.url !== "/command") return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${config.key}`) return send(401, { error: "unauthorized" });

    let cmd: Command;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      cmd = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof cmd?.text !== "string") throw new Error();
    } catch {
      return send(400, { error: 'send JSON like {"text": "skip this song"}' });
    }

    const started = Date.now();
    log({ command: cmd.text });
    try {
      const reply = await runAgent(cmd, { chat: config.chat, hands: config.hands, people: await people(config.folder), log });
      log({ reply, ms: Date.now() - started });
      send(200, reply);
    } catch (err) {
      log({ error: String(err), ms: Date.now() - started });
      // The usual shape, so the Shortcut just speaks the problem.
      send(200, { say: "Sorry, something went wrong on the Mac.", steps: [] });
    }
  };
}

if (import.meta.main) {
  const config = configFromEnv();
  await mkdir(config.folder, { recursive: true });
  const port = Number(process.env.PORT || 8787);
  createServer(handler(config)).listen(port, "127.0.0.1", () => console.log(`Alfred listening on http://127.0.0.1:${port}`));
}
