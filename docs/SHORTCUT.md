# The Alfred Shortcuts

Setup builds these for you (`src/shortcut.ts`), signs them with your Apple Account and opens them on
the Mac; after you click **Add Shortcut**, iCloud puts them on your iPhone. Nothing to build by
hand.

- **Alfred**: on the iPhone it listens (dictation stops when you pause); on the Mac it asks you to
  type. It sends what you said to Alfred on the Mac mini, speaks the answer, and does the phone
  steps Alfred sends back: skip / previous / pause / play, volume, brightness, flashlight, Do Not
  Disturb, timers, alarms, and opening apps, links, directions and calls.
- **Type to Alfred**: the same, but always typed (for when you can't talk).

Text handed to "Alfred" (from the share sheet, or another shortcut's Run Shortcut) is used as the
command directly.

## On the iPhone, once

1. **Tailscale** from the App Store, logged in with the same account as the Mac, with **VPN On
   Demand** on (so the phone can always reach the Mac).
2. Open **Shortcuts**. "Alfred" and "Type to Alfred" arrive through iCloud within a minute or so
   (open the app if they don't show up).
3. Run **Alfred** once and allow what it asks: dictation, and connecting to your Mac's address.
4. **"Hey Alfred" without Siri:** Settings → Accessibility → **Vocal Shortcuts** → Add Action →
   Shortcut → Alfred, and say "Hey Alfred" three times when asked.

Other ways to start it: "Hey Siri, Alfred"; the **Action Button** (Settings → Action Button →
Shortcut → Alfred); **Back Tap** (Accessibility → Touch → Back Tap); and on the Mac, Spotlight, or a
keyboard shortcut you set in the Shortcuts app (Alfred → ⓘ → Add Keyboard Shortcut).

## If something's off

- **"Could not connect to the server":** Tailscale is off on the phone, or "Limit IP Address
  Tracking" / iCloud Private Relay is in the way (Settings → Wi-Fi → your network, and Settings →
  your name → iCloud → Private Relay).
- **It says "Sorry, something went wrong on the Mac":** on the Mac, run `alfred doctor`.
- **"I'm on it" and then nothing:** the job is finishing in the background; the result arrives as a
  notification (if Bark is set up) and is always in `~/Library/Logs/Alfred/alfred.log`.
- **Music pauses while you talk and stays paused after "skip":** dictation took over the audio; say
  "skip and play".
- **Changed the Mac's Tailscale name, or Alfred's password:** run setup again; it rebuilds the
  Shortcuts (delete the old two when it asks).
