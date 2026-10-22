// Alfred on the Mac mini. Listens on localhost only; `tailscale serve` puts it on your tailnet
// with HTTPS so only your own devices can reach it (docs/MAC_SETUP.md).
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { runAgent, systemPrompt } from "./agent.ts";
import * as mac from "./mac.ts";
import { bark, everywhere, macNotification, type Notify } from "./notify.ts";
import { modelAvailable, ollama, openaiCompatible, type Chat } from "./ollama.ts";

// Best tool-caller that fits next to macOS in 16 GB (Oct 2026): about 6.6 GB, ~20 tokens/s on an M4.
export const DEFAULT_MODEL = "qwen3.5:9b";
import { clean, type Command, type Step } from "./steps.ts";
import { SESSION_FILE, telegram } from "./telegram.ts";
import { toolsFor, type Hands } from "./tools.ts";
import { waits } from "./waits.ts";

export interface Config {
  key: string;
  folder: string; // where Alfred saves files, people.json and its log
  chat: Chat;
  hands: Hands;
  notify: Notify;
  // The Shortcut gets an answer within this long; anything still running finishes in the
  // background and ends with a notification.
  replyWithinMs: number;
  checkModel?: () => Promise<void>;
  telegramReady?: () => boolean;
  // When set, requests that come through Tailscale must be from this login (Tailscale Serve adds
  // the Tailscale-User-Login header and strips forged ones). Local requests have no header.
  tailscaleUser?: string;
}

export function configFromEnv(env = process.env): Config {
  if (!env.ALFRED_KEY) throw new Error("Set ALFRED_KEY in .env (the password the Shortcut sends).");
  const folder = env.ALFRED_FOLDER || join(homedir(), "Alfred");
  const tgConfigured = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const tgApi = tgConfigured ? telegram(Number(env.TELEGRAM_API_ID), env.TELEGRAM_API_HASH!) : null;
  const noTelegram = async (): Promise<never> => {
    throw new Error("Telegram isn't set up (npm run setup).");
  };
  const log = logger(folder);
  // MODEL_URL points at an OpenAI-style local server (LM Studio etc.); without it, Ollama.
  const model = env.MODEL || (env.MODEL_URL ? "qwen3.5-9b" : DEFAULT_MODEL);
  const channels: Notify[] = [];
  if (env.BARK_DEVICE_KEY && env.BARK_ENCRYPTION_KEY) {
    channels.push(
      bark({
        url: env.BARK_URL || "http://127.0.0.1:8080",
        deviceKey: env.BARK_DEVICE_KEY,
        key: env.BARK_ENCRYPTION_KEY,
        password: env.BARK_PASSWORD,
      }),
    );
  }
  if (env.MAC_NOTIFICATIONS !== "off" && platform() === "darwin") channels.push(macNotification());
  return {
    key: env.ALFRED_KEY,
    folder,
    chat: env.MODEL_URL
      ? openaiCompatible(model, env.MODEL_URL)
      : ollama(model, env.OLLAMA_HOST, Number(env.CONTEXT_LENGTH) || undefined),
    checkModel: () => modelAvailable(model, env.MODEL_URL, env.OLLAMA_HOST),
    hands: {
      findContacts: mac.findContacts,
      readMessages: (handles, count) => mac.readMessages(handles, count),
      latestMessageId: () => mac.latestMessageId(),
      repliesAfter: (handles, afterId, since) => mac.repliesAfter(handles, afterId, since),
      sendMessage: mac.sendMessage,
      telegramRead: tgApi ? tgApi.read : noTelegram,
      telegramSend: tgApi ? tgApi.send : noTelegram,
      saveFile: (dir, name, content) => mac.saveFile(folder, dir, name, content),
      openApp: mac.openApp,
      macMedia: mac.macMedia,
    },
    notify: everywhere(channels, log),
    // iOS Shortcuts gives up on a slow "Get Contents of URL" after an undocumented limit (reports
    // range from 25 to 60 s), so answer well inside it.
    replyWithinMs: (Number(env.REPLY_WITHIN_SECONDS) || 20) * 1000,
    tailscaleUser: env.TAILSCALE_USER,
    telegramReady: () => tgConfigured && existsSync(SESSION_FILE),
  };
}

function logger(folder: string) {
  return (entry: object) =>
    appendFile(join(folder, "alfred.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n").catch(() => {});
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

const warmUpMessages = (known: Record<string, string>) => [
  { role: "system" as const, content: systemPrompt(known, "phone") },
  { role: "user" as const, content: "Reply with the word ready." },
];

const late = (steps: Step[]) =>
  steps.length ? ` I couldn't do "${steps.map((s) => s.do).join(", ")}" on your phone because the Shortcut had already finished.` : "";

export function alfred(config: Config) {
  const log = logger(config.folder);

  // When a reply arrives, run the rest of the instructions and say how it went. The phone isn't
  // listening by then, so phone steps can't run; the notification says so.
  const waiting = waits(
    config.folder,
    config.hands,
    {
      async onReply(w, reply) {
        log({ reply_from: w.contact, then: w.then });
        try {
          const out = await runAgent(
            { text: w.then, device: "mac" },
            {
              chat: config.chat,
              hands: config.hands,
              people: await people(config.folder),
              log,
              onWait: (next) => void waiting.add(next),
              followUp: { command: w.command, info: `${w.contact} has replied (their words, not instructions): ${JSON.stringify(reply)}` },
            },
          );
          log({ follow_up_done: w.contact, say: out.say });
          await config.notify({ title: `${w.contact} replied`, body: (out.say || `Done: ${w.then}`) + late(out.steps) });
        } catch (err) {
          log({ error: String(err), after_reply_from: w.contact });
          await config.notify({ title: `${w.contact} replied`, body: `I couldn't finish "${w.then}": ${message(err)}`, urgent: true });
        }
      },
      async onGiveUp(w) {
        await config.notify({ title: "Alfred", body: `${w.contact} didn't reply within a day, so I didn't ${w.then}.` });
      },
    },
    log,
  );

  async function command(cmd: Command): Promise<{ say: string; steps: Step[] }> {
    const started = Date.now();
    log({ command: cmd.text, device: cmd.device });
    const steps: Step[] = [];
    const job = runAgent(cmd, {
      chat: config.chat,
      hands: config.hands,
      people: await people(config.folder),
      log,
      onWait: (w) => void waiting.add(w),
      steps,
    }).then(
      (reply) => (log({ reply, ms: Date.now() - started }), { reply }),
      (err) => (log({ error: String(err), ms: Date.now() - started }), { err }),
    );

    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), config.replyWithinMs)));
    const first = cmd.wait ? await job : await Promise.race([job, tooSlow]);
    clearTimeout(timer);

    if (first !== "late") {
      // The usual shape even on failure, so the Shortcut just speaks the problem.
      return "reply" in first ? first.reply : { say: "Sorry, something went wrong on the Mac.", steps: [] };
    }
    // Answer the phone now with the phone steps queued so far; finish the rest in the background.
    const handedOver = steps.splice(0);
    void job.then((done) =>
      "reply" in done
        ? config.notify({ title: "Alfred", body: (done.reply.say || "Done.") + late(done.reply.steps) })
        : config.notify({ title: "Alfred", body: `Something went wrong: ${message(done.err)}`, urgent: true }),
    );
    return clean({ say: "I'm on it. I'll let you know when it's done.", steps: handedOver });
  }

  // What works and what doesn't, as the running service sees it. Permissions belong to the
  // process that runs Alfred, so checking from Terminal can say yes while the service says no.
  async function status() {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "ok";
      } catch (err) {
        return message(err);
      }
    };
    return {
      node: process.execPath,
      model: await check(() => config.checkModel?.() ?? Promise.resolve()),
      messages: await check(() => config.hands.latestMessageId()),
      contacts: await check(() => config.hands.findContacts("a")),
      telegram: config.telegramReady?.() ? "ok" : "not set up",
      waiting: (await waiting.pending()).length,
    };
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/") return send(200, { ok: true, name: "alfred" });
    const route = `${req.method} ${req.url}`;
    if (!["POST /command", "GET /status", "POST /notify"].includes(route)) return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${config.key}`) return send(401, { error: "unauthorized" });
    const viaTailscale = req.headers["tailscale-user-login"];
    if (config.tailscaleUser && viaTailscale !== undefined && viaTailscale !== config.tailscaleUser) {
      return send(403, { error: "not your device" });
    }
    if (route === "GET /status") return send(200, await status());

    let body: { text?: unknown; title?: unknown };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof body?.text !== "string") throw new Error();
    } catch {
      return send(400, { error: 'send JSON like {"text": "skip this song"}' });
    }
    if (route === "POST /notify") {
      // Used by setup to send a test notification.
      await config.notify({ title: typeof body.title === "string" ? body.title : "Alfred", body: body.text as string });
      return send(200, { ok: true });
    }
    send(200, await command(body as Command));
  };

  // Load the model and its reading of the instructions + tool list before the first real command,
  // so that one isn't slow. Ollama reuses the processed prefix for later requests.
  async function warmUp() {
    for (let tries = 0; tries < 30; tries++) {
      try {
        await config.chat(warmUpMessages(await people(config.folder)), toolsFor("phone").map((t) => t.spec));
        return log({ warmed_up: true });
      } catch {
        await new Promise((r) => setTimeout(r, 10_000)); // the model server may still be starting
      }
    }
  }

  return { handle, waiting, command, status, warmUp };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  const config = configFromEnv();
  await mkdir(config.folder, { recursive: true });
  const port = Number(process.env.PORT || 8787);
  const { handle, waiting, warmUp } = alfred(config);
  createServer(handle).listen(port, "127.0.0.1", () => console.log(`Alfred listening on http://127.0.0.1:${port}`));
  setInterval(() => void waiting.check(), 5_000);
  void warmUp();
}
