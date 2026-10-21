import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.ts";
import { clean } from "../src/brain.ts";

// Workers AI stand-in: records each call and answers with `response`.
function fakeAi(response: unknown) {
  const calls: { model: string; input: any }[] = [];
  const ai = {
    run: async (model: string, input: unknown) => {
      calls.push({ model, input });
      if (response instanceof Error) throw response;
      return { response };
    },
  } as unknown as Ai;
  return { ai, calls };
}

const unusedAi = fakeAi(new Error("Workers AI should not be called")).ai;
// With ANTHROPIC_API_KEY set, Claude is used.
const env = { AI: unusedAi, ANTHROPIC_API_KEY: "sk-test", ALFRED_KEY: "secret" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

// Stands in for the Messages API: records the request and answers with `reply` as the model's JSON text.
function fakeApi(reply: unknown, extra: Record<string, unknown> = {}) {
  const seen: { url: string; headers: Headers; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers, body: await req.json() });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(reply) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        ...extra,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return seen;
}

function command(body: unknown, key = "secret", withEnv: Parameters<typeof worker.fetch>[1] = env) {
  return worker.fetch(
    new Request("https://alfred.example/command", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    withEnv,
  );
}

const step = (s: Partial<Record<string, unknown>>) => ({ value: 0, text: "", who: "", url: "", when: "", ...s });

test("without an Anthropic key, Workers AI does the thinking", async () => {
  const { ai, calls } = fakeAi({ say: "", steps: [step({ do: "next" })] });
  const res = await command({ text: "skip this song", now: "2026-10-21T14:05:00+03:00" }, "secret", { AI: ai, ALFRED_KEY: "secret" });
  assert.deepEqual(await res.json(), { say: "", steps: [step({ do: "next" })] });
  assert.equal(calls[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(calls[0].input.response_format.type, "json_schema");
  assert.equal(calls[0].input.messages[0].role, "system");
  assert.match(calls[0].input.messages[1].content, /Command: skip this song/);
});

test("Workers AI: MODEL override, JSON returned as text, and failures", async () => {
  const text = fakeAi(JSON.stringify({ say: "Done.", steps: [step({ do: "timer", value: 600 })] }));
  const res = await command({ text: "ten minute timer" }, "secret", { AI: text.ai, ALFRED_KEY: "secret", MODEL: "@cf/other/model" });
  assert.deepEqual(await res.json(), { say: "Done.", steps: [step({ do: "timer", value: 600 })] });
  assert.equal(text.calls[0].model, "@cf/other/model");

  for (const bad of [new Error("quota"), "not json", null]) {
    const body = (await (await command({ text: "pause" }, "secret", { AI: fakeAi(bad).ai, ALFRED_KEY: "secret" })).json()) as any;
    assert.deepEqual(body.steps, []);
    assert.match(body.say, /Sorry/);
  }
});

test("skip this song becomes a next step (Claude)", async () => {
  const seen = fakeApi({ say: "", steps: [step({ do: "next" })] });
  const res = await command({ text: "skip this song", now: "2026-10-21T14:05:00+03:00" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { say: "", steps: [step({ do: "next" })] });

  const { url, headers, body } = seen[0];
  assert.match(url, /\/v1\/messages/);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.match(body.messages[0].content, /Local time: 2026-10-21T14:05:00\+03:00\nCommand: skip this song/);
});

test("MODEL overrides the Claude model", async () => {
  const seen = fakeApi({ say: "", steps: [] });
  await worker.fetch(
    new Request("https://alfred.example/command", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ text: "pause" }),
    }),
    { ...env, MODEL: "claude-haiku-5-5" },
  );
  assert.equal(seen[0].body.model, "claude-haiku-5-5");
});

test("wrong or missing key is rejected before calling Claude", async () => {
  const seen = fakeApi({ say: "", steps: [] });
  assert.equal((await command({ text: "pause" }, "nope")).status, 401);
  const noKey = await worker.fetch(
    new Request("https://alfred.example/command", { method: "POST", headers: { authorization: "Bearer " }, body: "{}" }),
    { ...env, ALFRED_KEY: "" },
  );
  assert.equal(noKey.status, 401);
  assert.equal(seen.length, 0);
});

test("bad body is a 400, empty text needs no API call", async () => {
  const seen = fakeApi({ say: "", steps: [] });
  assert.equal((await command({ nope: 1 })).status, 400);
  assert.deepEqual(await (await command({ text: "  " })).json(), { say: "Sorry, I didn't catch that.", steps: [] });
  assert.equal(seen.length, 0);
});

test("API failure still answers in the Shortcut's shape", async () => {
  globalThis.fetch = (async () => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"x"}}', { status: 400 })) as typeof fetch;
  const body = (await (await command({ text: "pause" })).json()) as { say: string; steps: unknown[] };
  assert.deepEqual(body.steps, []);
  assert.match(body.say, /Sorry/);
});

test("refusal returns no steps", async () => {
  fakeApi({ say: "", steps: [step({ do: "next" })] }, { stop_reason: "refusal", content: [] });
  assert.deepEqual(await (await command({ text: "x" })).json(), { say: "I can't help with that.", steps: [] });
});

test("clean clamps levels and drops unknown actions", () => {
  const out = clean({
    say: "ok",
    steps: [
      step({ do: "volume", value: 140 }),
      step({ do: "brightness", value: -5 }),
      step({ do: "timer", value: 299.6 }),
      step({ do: "format_phone" }),
    ] as any,
  });
  assert.deepEqual(
    out.steps.map((s) => [s.do, s.value]),
    [["volume", 100], ["brightness", 0], ["timer", 300]],
  );
});

test("health check and unknown routes", async () => {
  assert.equal((await worker.fetch(new Request("https://alfred.example/"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://alfred.example/x"), env)).status, 404);
});
