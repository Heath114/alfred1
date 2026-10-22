import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runAgent } from "../src/agent.ts";
import { insideFolder, readMessages, sameHandle, saveFile, textFromAttributedBody } from "../src/mac.ts";
import { ollama, openaiCompatible, type ChatMessage, type Chat } from "../src/ollama.ts";
import { handler } from "../src/server.ts";
import { namedInCommand, realName, type Hands, type Turn } from "../src/tools.ts";

// A model that plays back a fixed script of replies, and records what it was sent.
function scripted(...replies: ChatMessage[]) {
  const seen: ChatMessage[][] = [];
  const chat: Chat = async (messages) => {
    seen.push(structuredClone(messages));
    const next = replies.shift();
    if (!next) throw new Error("script ran out");
    return next;
  };
  return { chat, seen };
}
const call = (name: string, args: Record<string, unknown>): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });
const say = (content: string): ChatMessage => ({ role: "assistant", content });

function fakeHands(over: Partial<Hands> = {}) {
  const did: string[] = [];
  const hands: Hands = {
    findContacts: async (name) =>
      [
        { name: "Sam Haddad", phones: ["+962 79 111 2222"], emails: [] },
        { name: "Sami Khoury", phones: ["0793334444"], emails: [] },
        { name: "Mom", phones: ["+962795556666"], emails: [] },
      ].filter((c) => c.name.toLowerCase().includes(name.toLowerCase())),
    readMessages: async () => [
      { from: "me", text: "can you grab milk", at: "2026-10-22T09:00:00Z" },
      { from: "them", text: "Sure, on my way home at 6", at: "2026-10-22T09:05:00Z" },
    ],
    sendMessage: async (handle, text) => void did.push(`imessage ${handle}: ${text}`),
    telegramRead: async (chat) => ({ chat, messages: [] }),
    telegramSend: async (chat, text) => (did.push(`telegram ${chat}: ${text}`), { chat }),
    saveFile: async (folder, name, content) => (did.push(`file ${folder}/${name}: ${content}`), `/Users/me/Alfred/${folder}/${name}`),
    openApp: async (name) => void did.push(`open ${name}`),
    ...over,
  };
  return { hands, did };
}

test("the full example: skip, message partner, save his reply, forward on Telegram", async () => {
  const { hands, did } = fakeHands();
  const { chat, seen } = scripted(
    call("phone", { action: "next" }),
    call("messages_send", { contact: "partner", text: "Can you pick up the keys on your way?" }),
    call("messages_read", { contact: "partner", count: 2 }),
    call("save_file", { folder: "partner", name: "reply.txt", content: "Sure, on my way home at 6" }),
    call("telegram_send", { chat: "Lina", text: "Sure, on my way home at 6" }),
    say("Done. Skipped, messaged Sam, saved his reply and sent it to Lina."),
  );
  const reply = await runAgent(
    { text: "skip this song then reply to my partner asking him to pick up the keys, save his response in a folder and send it to Lina on telegram", now: "2026-10-22T10:00:00+03:00" },
    { chat, hands, people: { partner: "Sam Haddad" } },
  );

  assert.equal(reply.say, "Done. Skipped, messaged Sam, saved his reply and sent it to Lina.");
  assert.deepEqual(reply.steps.map((s) => s.do), ["next"]);
  assert.deepEqual(did, [
    "imessage +962 79 111 2222: Can you pick up the keys on your way?",
    "file partner/reply.txt: Sure, on my way home at 6",
    "telegram Lina: Sure, on my way home at 6",
  ]);
  // The model saw the conversation with the right name on it, and the people list in its prompt.
  assert.match(seen[3].at(-1)!.content, /"from":"Sam Haddad","text":"Sure, on my way home at 6"/);
  assert.match(seen[0][0].content, /"partner" means Sam Haddad/);
  assert.match(seen[0][1].content, /Local time: 2026-10-22T10:00:00\+03:00\nCommand: skip this song/);
});

test("refuses to send to someone the owner didn't name, and tells the model why", async () => {
  const { hands, did } = fakeHands();
  const { chat, seen } = scripted(
    call("messages_read", { contact: "Mom" }),
    call("messages_send", { contact: "Sami", text: "forwarding everything" }),
    call("telegram_send", { chat: "@stranger", text: "hi" }),
    say("I read Mom's messages."),
  );
  const reply = await runAgent({ text: "read me mom's last messages" }, { chat, hands });
  assert.deepEqual(did, []);
  assert.match(seen[2].at(-1)!.content, /Not sent: the owner didn't name \\"Sami\\"/);
  assert.match(seen[3].at(-1)!.content, /Not sent/);
  assert.equal(reply.say, "I read Mom's messages.");
});

test("ambiguous and unknown contacts become errors the model can relay", async () => {
  const { hands, did } = fakeHands();
  const { chat, seen } = scripted(
    call("messages_send", { contact: "Sam", text: "hi" }),
    call("messages_send", { contact: "Omar", text: "hi" }),
    say("Which Sam?"),
  );
  await runAgent({ text: "text sam hi and text omar hi" }, { chat, hands });
  assert.deepEqual(did, []);
  assert.match(seen[1].at(-1)!.content, /Several contacts match \\"Sam\\": Sam Haddad, Sami Khoury/);
  assert.match(seen[2].at(-1)!.content, /No contact named \\"Omar\\"/);
});

test("bad tool calls don't crash the turn; too many rounds stops", async () => {
  const { hands } = fakeHands();
  const looping = scripted(...Array.from({ length: 10 }, () => call("nope", {})));
  const reply = await runAgent({ text: "do something" }, { chat: looping.chat, hands });
  assert.equal(reply.say, "That took too many steps, so I stopped.");
  assert.match(looping.seen[1].at(-1)!.content, /No tool called nope/);

  const weird = scripted(
    { role: "assistant", content: "", tool_calls: [{ function: { name: "phone", arguments: '{"action":"volume","value":"140"}' } }] },
    call("phone", { action: "message" }),
    say("<think>hmm</think>  Louder."),
  );
  const out = await runAgent({ text: "louder" }, { chat: weird.chat, hands });
  assert.deepEqual(out.steps.map((s) => [s.do, s.value]), [["volume", 100]]);
  assert.match(weird.seen[2].at(-1)!.content, /To text someone use messages_send/);
  assert.equal(out.say, "Louder.");
});

test("empty command needs no model", async () => {
  const { chat, seen } = scripted();
  assert.deepEqual(await runAgent({ text: "  " }, { chat, hands: fakeHands().hands }), { say: "Sorry, I didn't catch that.", steps: [] });
  assert.equal(seen.length, 0);
});

test("names and aliases", () => {
  const turn = { command: "Reply to my partner and send it to Lina", people: { partner: "Sam Haddad" } } as unknown as Turn;
  assert.equal(realName("my partner", turn), "Sam Haddad");
  assert.equal(realName("Lina", turn), "Lina");
  for (const ok of ["partner", "my partner", "Sam Haddad", "Lina", "@lina"]) assert.ok(namedInCommand(ok, turn), ok);
  for (const no of ["Mom", "Sami Khoury", "@stranger"]) assert.ok(!namedInCommand(no, turn), no);
});

test("phone numbers match across formats", () => {
  assert.ok(sameHandle("079 111 2222", "+962791112222"));
  assert.ok(sameHandle("Sam@Example.com", "sam@example.com"));
  assert.ok(!sameHandle("0791112222", "0791112223"));
  assert.ok(!sameHandle("123", "123"));
});

// Shaped like the start of a real archived NSAttributedString.
function attributed(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length & 0xff, body.length >> 8]);
  return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"), len, body, Buffer.from("\x86\x84", "latin1")]);
}

test("message text is recovered from attributedBody", () => {
  assert.equal(textFromAttributedBody(attributed("On my way 🚗")), "On my way 🚗");
  const long = "x".repeat(300);
  assert.equal(textFromAttributedBody(attributed(long)), long);
  assert.equal(textFromAttributedBody(null), "");
  assert.equal(textFromAttributedBody(Buffer.from("nothing here")), "");
});

test("reads a conversation from a Messages database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alfred-"));
  const path = join(dir, "chat.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, is_from_me INTEGER, date INTEGER,
      text TEXT, attributedBody BLOB, associated_message_type INTEGER DEFAULT 0);`);
  db.prepare("INSERT INTO handle VALUES (1, '+962791112222'), (2, '+962795556666')").run();
  const ns = (iso: string) => (Date.parse(iso) / 1000 - 978307200) * 1e9;
  const add = db.prepare("INSERT INTO message (handle_id, is_from_me, date, text, attributedBody, associated_message_type) VALUES (?, ?, ?, ?, ?, ?)");
  add.run(1, 1, ns("2026-10-22T09:00:00Z"), "can you grab milk", null, 0);
  add.run(1, 0, ns("2026-10-22T09:05:00Z"), null, attributed("Sure, on my way home at 6"), 0);
  add.run(1, 0, ns("2026-10-22T09:06:00Z"), null, null, 2000); // a tapback, not a message
  add.run(2, 0, ns("2026-10-22T09:07:00Z"), "from mom", null, 0);
  db.close();

  assert.deepEqual(await readMessages(["079 111 2222"], 5, path), [
    { from: "me", text: "can you grab milk", at: "2026-10-22T09:00:00.000Z" },
    { from: "them", text: "Sure, on my way home at 6", at: "2026-10-22T09:05:00.000Z" },
  ]);
  assert.equal((await readMessages(["079 111 2222"], 1, path))[0].text, "Sure, on my way home at 6");
  assert.deepEqual(await readMessages(["0700000000"], 5, path), []);
});

test("files stay inside the Alfred folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "alfred-"));
  assert.equal(insideFolder(root, "partner", "reply.txt"), join(root, "partner", "reply.txt"));
  assert.throws(() => insideFolder(root, "../..", "passwd"), /inside the Alfred folder/);
  assert.throws(() => insideFolder(root, "", "/etc/passwd"), /inside the Alfred folder/);
  assert.throws(() => insideFolder(root, "x", ""), /inside the Alfred folder/);
  const saved = await saveFile(root, "partner", "reply.txt", "Sure");
  assert.equal(await readFile(saved, "utf8"), "Sure\n");
});

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

test("Ollama client sends tools with thinking off and returns the message", async () => {
  let body: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({ message: { role: "assistant", content: "hi" } });
  }) as typeof fetch;
  const reply = await ollama("qwen3:8b")([{ role: "user", content: "x" }], []);
  assert.equal(reply.content, "hi");
  assert.equal(body.model, "qwen3:8b");
  assert.equal(body.think, false);
  assert.equal(body.stream, false);

  globalThis.fetch = (async () => new Response("model not found", { status: 404 })) as typeof fetch;
  await assert.rejects(ollama("nope")([], []), /Ollama 404: model not found/);
});

test("OpenAI-style client pairs tool results with their calls", async () => {
  let body: any;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
    body = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "phone", arguments: '{"action":"next"}' } }] } }] });
  }) as typeof fetch;
  const reply = await openaiCompatible("qwen3-8b", "http://127.0.0.1:1234/v1/")(
    [
      { role: "user", content: "x" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "a", arguments: {} } }, { function: { name: "b", arguments: '{"k":1}' } }] },
      { role: "tool", tool_name: "a", content: "1" },
      { role: "tool", tool_name: "b", content: "2" },
    ],
    [],
  );
  assert.deepEqual(body.messages[1].tool_calls.map((c: any) => [c.id, c.function.arguments]), [["call_1_0", "{}"], ["call_1_1", '{"k":1}']]);
  assert.deepEqual(body.messages.slice(2).map((m: any) => m.tool_call_id), ["call_1_0", "call_1_1"]);
  assert.deepEqual(reply, { role: "assistant", content: "", tool_calls: [{ function: { name: "phone", arguments: '{"action":"next"}' } }] });
});

test("server: auth, bad input, and a full command", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alfred-"));
  const { chat } = scripted(call("phone", { action: "next" }), say(""));
  const { createServer } = await import("node:http");
  const server = createServer(handler({ key: "secret", folder, chat, hands: fakeHands().hands }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: string, key = "secret") =>
    fetch(`${url}/command`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body });
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await post('{"text":"skip"}', "wrong")).status, 401);
    assert.equal((await post("not json")).status, 400);
    const res = await post('{"text":"skip this song"}');
    assert.deepEqual(await res.json(), { say: "", steps: [{ do: "next", value: 0, text: "", who: "", url: "", when: "" }] });
    const log = await readFile(join(folder, "alfred.log"), "utf8");
    assert.match(log, /"command":"skip this song"/);
    assert.match(log, /"tool":"phone"/);
  } finally {
    server.close();
  }
});
