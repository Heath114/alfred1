# Alfred

Voice control for my iPhone. "Hey Alfred, skip this song" skips whatever is playing, in whatever
app. Same for pause, volume, timers, alarms, reminders, texting and calling people, opening apps,
directions, and quick questions.

## How it works

```
"Hey Alfred"  ──►  Shortcut "Alfred" listens  ──►  POST /command {"text": "skip this song"}
 (Vocal Shortcut)                                            │
                                                             ▼
                                                 Worker (this repo) asks Claude,
                                                 returns {"say": "", "steps": [{"do": "next", ...}]}
                                                             │
                     Shortcut runs each step  ◄──────────────┘
                     (Skip Forward, Set Volume, Send Message...) and speaks "say"
```

iOS doesn't let any app listen for its own wake word or control other apps, but Shortcuts can:
**Vocal Shortcuts** (iOS 18+) start a shortcut from a phrase you train, without Siri, and
Shortcuts' media actions control whatever app is playing. This repo is the brain in the middle:
a Cloudflare Worker that turns what you said into steps the Shortcut can run.

- `src/brain.ts`: the prompt, the list of actions, and the Claude call (structured output, so the
  reply always has the shape the Shortcut expects).
- `src/worker.ts`: the HTTP endpoint, protected by a shared key.
- `docs/SHORTCUT.md`: building the Shortcut on the phone.

The actions are fixed by what the Shortcut has blocks for: `next`, `previous`, `pause`, `play`,
`volume`, `brightness`, `flashlight`, `focus`, `timer`, `alarm`, `reminder`, `message`, `call`,
`open` (any app URL scheme or link). To add one: add it to `ACTIONS` and the prompt in
`src/brain.ts`, and a block to the Shortcut.

## Deploy (about 5 minutes)

Needs Node 22+, a free Cloudflare account and an Anthropic API key (console.anthropic.com).

```sh
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY     # paste the API key
npx wrangler secret put ALFRED_KEY            # paste a long random password; the Shortcut sends it
npx wrangler deploy                           # prints https://alfred.<you>.workers.dev
```

Check it (PowerShell: use `curl.exe`):

```sh
curl -X POST https://alfred.<you>.workers.dev/command \
  -H "Authorization: Bearer <ALFRED_KEY>" -d '{"text": "skip this song"}'
# {"say":"","steps":[{"do":"next","value":0,"text":"","who":"","url":"","when":""}]}
```

Then build the Shortcut: [`docs/SHORTCUT.md`](docs/SHORTCUT.md).

## Model

`claude-opus-5-5` at low effort. For quicker, cheaper replies set `MODEL = "claude-haiku-5-5"`
under `[vars]` in `wrangler.toml` and deploy again. Requests use server-side refusal fallbacks
(`fallbacks: "default"`), so a request a model declines is retried on another one automatically.

## Developing

```sh
npm test                 # Worker + brain, with the Claude API stubbed
npm run typecheck
ANTHROPIC_API_KEY=... npm run try -- "skip this song" "text mom I'm 10 minutes late"   # real API, prints timing
npx wrangler dev         # local Worker; put the two secrets in .dev.vars
npx wrangler tail        # live logs from the deployed Worker
```

## Later

- Mac: the same Worker, with a Mac client that can do far more (AppleScript, any app).
- Remember things ("my gym playlist", who "the boss" is) in a small KV store the prompt reads.
