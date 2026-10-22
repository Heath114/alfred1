# Setting up Alfred on the Mac mini

About 30 minutes. Everything runs on the Mac: the AI model, your messages and your files stay there.
The iPhone reaches it through Tailscale, an encrypted private network between your own devices.

## 1. Install the tools

Open **Terminal** and install Homebrew if you don't have it (https://brew.sh), then:

```sh
brew install node git ollama
brew services start ollama        # keeps the model server running, also after a restart
ollama pull qwen3:8b              # the AI model, about 5 GB
```

`qwen3:8b` is the largest good model that fits comfortably next to macOS in 16 GB. Any Ollama model
with tool support works: set `MODEL` in `.env` (step 3).

Prefer LM Studio (often faster on Apple Silicon, MLX models)? Load a model there, start its local
server, and put `MODEL_URL=http://127.0.0.1:1234/v1` and `MODEL=<its model id>` in `.env` instead.

## 2. Get Alfred

```sh
git clone https://github.com/Heath114/alfred1 ~/alfred
cd ~/alfred
npm install
```

## 3. Settings

```sh
cp .env.example .env
openssl rand -base64 24           # copy the output: this is Alfred's password
open -e .env                      # paste it after ALFRED_KEY=
```

Tell Alfred who people are. Create `~/Alfred/people.json` with the names exactly as they are in
Contacts:

```json
{ "partner": "Sam Haddad", "mom": "Mom" }
```

Then "reply to my partner" works. Alfred only ever sends a message to someone you named in that
command (directly or by one of these words), whatever the messages it reads say.

## 4. Messages and Contacts

1. Open **Messages** on the Mac and sign in with your Apple ID. In Messages → Settings → iMessage,
   turn on **Enable Messages in iCloud**, so the Mac has the same conversations as your phone.
2. System Settings → Privacy & Security → **Full Disk Access** → add **Terminal** (lets Alfred read
   your message history).
3. Start Alfred once (step 6) and ask it to read and send a message. macOS asks whether Terminal
   may control **Contacts** and **Messages**: click **Allow**.

## 5. Telegram (optional)

1. On https://my.telegram.org → **API development tools**, create an app (any name). Copy `api_id`
   and `api_hash` into `.env`.
2. `npm run telegram-login` and enter your phone number and the code Telegram sends you.

This logs Alfred into **your** Telegram account, so it reads and sends as you. The login is saved
only on this Mac (`~/.alfred/telegram.session`).

## 6. Run it

```sh
npm start
```

In a second Terminal window:

```sh
curl -X POST http://127.0.0.1:8787/command -H "Authorization: Bearer <your ALFRED_KEY>" \
  -d '{"text": "read me my last messages from my partner"}'
```

Everything Alfred does is logged to `~/Alfred/alfred.log`.

## 7. Reach it from the iPhone: Tailscale

1. Install **Tailscale** on the Mac (`brew install --cask tailscale`, or the App Store) and on the
   iPhone (App Store). Sign in to both with the same account.
2. On the Mac: `tailscale serve --bg 8787`. It prints your Mac's private address, like
   `https://mac-mini.tail1234.ts.net`. (The first time it may ask you to enable HTTPS in the
   Tailscale admin page; follow its link.)
3. On the iPhone, in the Tailscale app, turn on **VPN On Demand** so it's always connected.

Only devices signed into your Tailscale account can reach that address. Tailscale can't read the
traffic: it's encrypted end to end between your phone and your Mac.

## 8. Point the Shortcut at the Mac

In the **Alfred** shortcut, in Get Contents of URL:
- URL: `https://<your mac address from step 7>/command`
- Authorization: `Bearer <your ALFRED_KEY>`

Everything else in the Shortcut stays the same ([`SHORTCUT.md`](SHORTCUT.md)).

## 9. Keep it running

1. System Settings → Energy: turn on **Prevent automatic sleeping when the display is off**.
2. System Settings → Users & Groups: turn on **Automatically log in** as you (Messages only works
   in a logged-in session).
3. Start Alfred at login. Save this as `~/Library/LaunchAgents/com.alfred.plist` (replace `YOU`
   with your Mac user name):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.alfred</string>
     <key>WorkingDirectory</key><string>/Users/YOU/alfred</string>
     <key>ProgramArguments</key>
     <array><string>/opt/homebrew/bin/npm</string><string>start</string></array>
     <key>EnvironmentVariables</key>
     <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardErrorPath</key><string>/Users/YOU/Alfred/server.err</string>
   </dict>
   </plist>
   ```

   Then `launchctl load ~/Library/LaunchAgents/com.alfred.plist`.
4. Running this way, macOS asks for permissions for **node** instead of Terminal: add
   `/opt/homebrew/bin/node` to Full Disk Access too (in the file picker press ⌘⇧G and paste the
   path), and allow Contacts/Messages when asked.

## 10. Remove the old cloud version

dash.cloudflare.com → Workers & Pages → **alfred** → Settings → **Delete**. Then delete any Cloudflare
API tokens you made for it.

## Troubleshooting

- **"Sorry, something went wrong on the Mac":** the reason is in `~/Alfred/alfred.log`.
- **Model is slow the first time:** it loads into memory (about 10 s), then stays loaded for an hour.
- **Can't read messages:** Full Disk Access is missing for Terminal (or node, step 9).
- **iPhone can't connect:** Tailscale is off on the phone, or `tailscale serve` isn't running
  (`tailscale serve status`).
