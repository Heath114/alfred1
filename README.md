# Alfred

A private assistant that lives on my Mac mini and takes orders from my iPhone. "Hey Alfred, skip this
song, then reply to my partner asking him to grab the keys, save his answer in a folder and send it
to Lina on Telegram": it does all of it, and none of it leaves my own devices. The AI model runs on
the Mac.

## How it works

```
iPhone                                    Mac mini at home
"Hey Alfred, …"  ─── Tailscale ───►  Alfred (this repo) ──► local AI model (Ollama / LM Studio)
 (Shortcut:                           │  decides what to do, step by step, with its tools:
  listens, sends                      │   Messages (read, send as me), Telegram (my account),
  the words)                          │   files, Mac apps, phone actions
      ◄── {"say": "...", "steps": [...]} ┘
 runs phone steps (skip, volume, timer…) and speaks "say"
```

- **Ears:** an iPhone Shortcut started by voice ("Hey Alfred" with Vocal Shortcuts, or Siri). It
  dictates what you say and sends it to the Mac. [`docs/SHORTCUT.md`](docs/SHORTCUT.md)
- **Brain:** a local model through Ollama (default `qwen3:8b`) or any OpenAI-style local server.
  It works in rounds: call a tool, read the result, call the next one, then answer.
- **Hands** (`src/tools.ts`):
  - `phone`: skip/pause/play, volume, brightness, flashlight, Focus, timers, alarms, reminders, calls,
    opening apps. These run on the iPhone, because iOS lets nothing else touch them.
  - `messages_read`, `messages_send`: iMessage/SMS through the Mac's Messages app and its database.
  - `wait_for_reply`: "…then save his answer and send it to Lina": Alfred watches for the reply and
    finishes the job when it arrives (up to 24 h, survives restarts; the outcome goes to the log).
  - `telegram_read`, `telegram_send`: your own Telegram account, through Telegram's official API.
  - `save_file`: files in `~/Alfred`.
  - `open_mac_app`.
- **Safety rails:** messages and files with placeholders (`${reply}`, `[his response]`) are refused,
  so the model has to read the real text. Right after messaging someone, only newer messages count
  as their reply. Alfred only sends to people you named in that command (directly or as "my
  partner" etc., from `~/Alfred/people.json`), so a message it reads can't redirect it. Files stay
  inside `~/Alfred`. Every command and tool call is logged to `~/Alfred/alfred.log`.

## Set up

[`docs/MAC_SETUP.md`](docs/MAC_SETUP.md) for the Mac, then [`docs/SHORTCUT.md`](docs/SHORTCUT.md) for
the iPhone.

## Develop

```sh
npm install
npm test          # agent loop, tools, Messages database reading, server, with a scripted model
npm run try -- "reply to my partner saying I'm on my way"   # real local model, pretend hands: nothing is sent
npm run typecheck
npm start         # needs macOS for the real hands
```

To add a hand: a tool in `src/tools.ts` (description + run), and its real implementation in
`src/mac.ts` behind the `Hands` interface.

## Next

- Spotify through its Web API, so music works when the phone isn't the one asking.
- Notes, Reminders and Calendar on the Mac (they sync to the phone through iCloud).
- Operating any Mac app by looking at the screen, as a fallback for things with no direct hand.
