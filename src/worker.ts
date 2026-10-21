import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, interpret, type Command } from "./brain.ts";

export interface Env {
  ANTHROPIC_API_KEY: string;
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
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
      return json(await interpret(client, cmd, env.MODEL || DEFAULT_MODEL));
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
