# Setting up Alfred on the Mac mini

One command, about 30 minutes the first time (most of it is the 6.6 GB model download). Do it at the
Mac itself (or through Screen Sharing): macOS only shows its permission prompts on the Mac's screen.

```sh
git clone https://github.com/Heath114/alfred1 ~/.alfred/app
~/.alfred/app/setup.sh
```

If macOS asks to install the command line developer tools when you run `git`, click Install, then
run the two lines again.

Setup explains each step as it goes, and is safe to run again any time: it checks what's already
done and skips it. Updating later is `cd ~/.alfred/app && git pull && ./setup.sh`.

## What setup does, and what you click

| Step | What happens | What you do |
|---|---|---|
| Node | Downloads its own copy of Node.js (checksum-verified) into `~/.alfred/runtime` | nothing |
| Model | Installs Ollama if needed and downloads `qwen3.5:9b` | maybe allow Homebrew / Ollama |
| Alfred.app | Builds a tiny app in `~/Applications` that holds Alfred's macOS permissions | nothing |
| Background | Starts Alfred as a login service, plus a watchdog | macOS shows "Background Items Added": leave it allowed |
| Permissions | Opens Full Disk Access with Alfred.app next to it | drag Alfred into the list; click **Allow** when asked about Messages and Reminders |
| People | Asks what you call people ("partner" = a name in Contacts) | type a few, or skip |
| Telegram | Optional: logs Alfred into your account | api_id/api_hash from my.telegram.org, then the login code |
| Tailscale | Puts Alfred on your private network | log in to Tailscale; approve HTTPS once if it asks |
| Notifications | Optional: Bark, encrypted end to end | set up the Bark app on the iPhone (setup lists the taps) |
| Power | Never sleep, restart after a power cut | your password, if you agree |
| Shortcuts | Builds, signs and opens the Alfred Shortcuts | click **Add Shortcut** twice (and delete your old hand-built "Alfred" first if you have one) |

Then on the iPhone: open Shortcuts, run **Alfred** once (allow dictation and the connection), and
add the **Vocal Shortcut** "Hey Alfred" (Settings → Accessibility → Vocal Shortcuts). Details in
[SHORTCUT.md](SHORTCUT.md).

## Where things live

| | |
|---|---|
| `~/Alfred` | yours: `people.json` and the files Alfred saves |
| `~/.alfred/app` | the code; `.env` holds Alfred's password and keys (readable only by you) |
| `~/.alfred/runtime` | Alfred's own Node.js |
| `~/Applications/Alfred.app` | holds the macOS permissions; leave it in place |
| `~/Library/Logs/Alfred` | `alfred.log` (every command and action), `server.log` |

## Why it's built this way (problems other Mac agents ran into)

- **Permissions that vanish.** macOS gives Full Disk Access and "control Messages" to the program
  that runs, not to a script. Agents run by Homebrew's `node` lose them on every Node update, and
  Apple-signed Node can't ask to control other apps at all. Alfred.app holds them instead and starts
  Node as its child; setup only rebuilds it when its own code changes.
- **Works in Terminal, fails as a service.** Permissions granted to Terminal don't carry over. Setup
  checks everything through the running service (`alfred doctor` does too).
- **Messages that say "sent" but weren't.** Alfred confirms each send in the Messages database and
  falls back to SMS when the person isn't on iMessage.
- **Old messages taken as replies.** After an iCloud resync, old messages can reappear as new rows;
  Alfred only counts messages newer than the moment it started waiting.
- **The model silently forgetting its instructions.** Ollama's default context window is small and
  overflows without an error; Alfred sets it on every request.
- **Slow first command.** The model and its instructions are loaded when Alfred starts.
- **Shortcut timeouts.** The iPhone gets an answer within 20 seconds; longer jobs finish in the
  background and end with a notification.

## Things macOS decides that setup can't change for you

- **FileVault vs. coming back alone.** With FileVault on (encrypted disk, the private choice), a
  restart or power cut leaves the Mac at the password screen and Alfred stays off until you log in.
  With FileVault off and automatic login on, it comes back by itself.
- **Tailscale key expiry.** In the Tailscale admin page, disable key expiry for the Mac, or it drops
  off the network after 180 days.
- **Apple's coming change.** Apple has announced that Full Disk Access will need "very explicit user
  action" in a future macOS, citing AI agents. When it lands, Alfred may need re-approving.

## When something's off

```sh
alfred doctor
```

It checks the service, the model, each permission, Tailscale, notifications and the Shortcuts, and
says how to fix what isn't working. Common fixes:

- **Alfred can't read Messages:** System Settings → Privacy & Security → Full Disk Access → Alfred
  on, then `launchctl kickstart -k gui/$UID/com.alfred.agent`.
- **Not allowed to use Messages/Reminders:** Privacy & Security → Automation → Alfred. If Alfred isn't
  listed: `tccutil reset AppleEvents com.alfred.agent`, then run setup again and click Allow.
- **The iPhone can't connect:** Tailscale on the phone is off, "Limit IP Address Tracking" or iCloud
  Private Relay is interfering, or the Mac's Tailscale name changed (run setup again).
- **Everything Alfred did and why:** `~/Library/Logs/Alfred/alfred.log`.
