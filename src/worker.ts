import Anthropic from "@anthropic-ai/sdk";
import { claude, interpret, workersAi, type Command } from "./brain.ts";

export interface Env {
  AI: Ai;
  // Optional. When set, Claude does the thinking instead of Workers AI.
  ANTHROPIC_API_KEY?: string;
  // Shared secret the Shortcut sends as "Authorization: Bearer <ALFRED_KEY>".
  ALFRED_KEY: string;
  MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "alfred" });
    if (request.method !== "POST" || url.pathname !== "/command") return json({ error: "not found" }, 404);

    if (!env.ALFRED_KEY || request.headers.get("authorization") !== `Bearer ${env.ALFRED_KEY}`) {
      return json({ error: "unauthorized" }, 401);
    }

    let cmd: Command;
    try {
      cmd = await request.json();
      if (typeof cmd?.text !== "string") throw new Error();
    } catch {
      return json({ error: 'send JSON like {"text": "skip this song"}' }, 400);
    }

    try {
      const think = env.ANTHROPIC_API_KEY
        ? claude(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 }), env.MODEL || undefined)
        : workersAi(env.AI, env.MODEL || undefined);
      return json(await interpret(think, cmd));
    } catch (err) {
      console.error(err);
      // Still a 200 with the usual shape, so the Shortcut just speaks the problem.
      return json({ say: "Sorry, my brain isn't answering right now.", steps: [] });
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
