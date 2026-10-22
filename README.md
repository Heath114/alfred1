# Alfred

A private assistant that lives on my Mac mini and takes orders from my iPhone or the Mac, by voice
or typed. "Hey Alfred, skip this song, then tell my partner to bring the keys, save his answer in a
folder and send it to Lina on Telegram": Alfred skips, sends the message, waits for the reply, then
saves it and forwards it, and tells me when it's done. The AI model runs on the Mac, so nothing I
say or send goes to an AI company.

## How it works

```
iPhone or Mac                                Mac mini at home
"Hey Alfred, …" / typed  ── Tailscale ──►  Alfred (this repo, as a login service in Alfred.app)
 (the Alfred Shortcut,                       │  works step by step with a local model (Ollama),
  or `alfred` in Terminal)                   │  using its tools:
                                             │   Messages · Telegram · Reminders · files · Mac apps
                                             │   · Mac music · phone actions · wait for a reply
        ◄── {"say": "...", "steps": [...]} ──┘
 the Shortcut speaks the answer and does the phone steps (skip, volume, timer, alarm, call...)

 later: "Sam replied, I saved it and sent it to Lina"  ──►  notification (Bark, encrypted)
```

- **Voice and typing, iPhone and Mac:** the generated "Alfred" Shortcut listens on the iPhone and
  takes typing on the Mac; "Type to Alfred" is always typed; `alfred` in Terminal is a chat prompt.
  "Hey Alfred" works without Siri through iOS Vocal Shortcuts.
- **Tools** (`src/tools.ts`): read/send iMessages (confirmed in the Messages database, SMS fallback),
  wait for someone's reply and then finish the job, read/send Telegram as you, add reminders (they
  alert on the iPhone), save files to `~/Alfred`, open Mac apps, control music on the Mac, and phone
  actions for the Shortcut.
- **Safety rails:** Alfred only messages people you named in that command (or by alias from
  `~/Alfred/people.json`), so a message it reads can't redirect it. Placeholder text like
  `${reply}` is refused instead of sent. Files stay in `~/Alfred`. Every command and action is
  logged.
- **Private:** local model; Tailscale between your own devices; notifications encrypted with a key
  only your phone has; the Shortcuts are signed with your own Apple Account and nothing is
  uploaded.

## Set up

On the Mac mini:

```sh
git clone https://github.com/Heath114/alfred1 ~/.alfred/app
~/.alfred/app/setup.sh
```

Setup walks through everything (permissions, Tailscale, notifications, the Shortcuts) and can be
run again any time. Details: [docs/MAC_SETUP.md](docs/MAC_SETUP.md). iPhone side:
[docs/SHORTCUT.md](docs/SHORTCUT.md). If anything misbehaves: `alfred doctor`.

## Develop

```sh
npm install
npm test          # agent, tools, Messages/Contacts databases, notifications, server, Shortcut structure
npm run typecheck
npm run try -- "reply to my partner saying I'm on my way"          # real local model, pretend hands
npm run try -- --mac "skip this song and turn the volume down"     # as if typed on the Mac
```

- `src/agent.ts` the step-by-step loop; `src/tools.ts` what Alfred can do; `src/mac.ts` the Mac side
  (Messages, Contacts, Reminders, music, files); `src/telegram.ts`; `src/notify.ts`.
- `src/shortcut.ts` generates the Shortcuts; `src/install.ts` Alfred.app and the LaunchAgents;
  `mac/wrapper.c` Alfred.app's executable; `scripts/setup.ts`, `scripts/doctor.ts`.
- To add a tool: describe it in `src/tools.ts`, implement it in `src/mac.ts` behind the `Hands`
  interface. To add a phone action: add it to `ACTIONS` in `src/steps.ts` and a branch in
  `src/shortcut.ts` (a test checks they match).

## Not yet

- Spotify through its Web API, so "skip" works on the phone when the Mac asks.
- Operating any Mac app by looking at the screen, for things with no direct tool.
- Approve / cancel buttons on notifications.
