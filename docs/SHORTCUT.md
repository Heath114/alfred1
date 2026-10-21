# Building the Alfred Shortcut on your iPhone

About 20 minutes, once. You need the Worker deployed first (README, "Deploy"): its URL and your
`ALFRED_KEY`.

Shortcuts can't be imported from a file built outside a Mac (Apple requires them signed), so this
is built by hand. Every action below is found with the search bar at the bottom of the Shortcuts
editor; type the name in **bold**.

## 1. The main shortcut: "Alfred"

Shortcuts app → **+** → name it **Alfred**.

1. **Dictate Text**. Tap the arrow: Language your language, Stop Listening **After Pause**.
2. **Current Date**.
3. **Format Date**: Date Format **ISO 8601**, Include ISO 8601 Time **on**.
4. **Get Contents of URL**: URL `https://alfred.<your-subdomain>.workers.dev/command`
   - Method **POST**
   - Headers: `Authorization` = `Bearer <your ALFRED_KEY>`
   - Request Body **JSON**:
     - `text` (Text) = the **Dictated Text** variable
     - `now` (Text) = the **Formatted Date** variable
5. **Get Dictionary Value**: Get **Value** for `say` in **Contents of URL**.
6. **If** **Dictionary Value** **has any value** →
   **Speak Text**: Dictionary Value. Turn **Wait Until Finished** on.
   **End If** (it adds Otherwise / End If on its own; leave Otherwise empty)
7. **Get Dictionary Value**: Get **Value** for `steps` in **Contents of URL**.
8. **Repeat with Each** item in **Dictionary Value** (the steps). Everything in section 2 goes
   **inside** this Repeat.

## 2. Inside the Repeat: one block per action

First, inside the Repeat, add these six so every block can use them (rename each variable by
tapping it → Rename, so they're easy to pick):

- **Get Dictionary Value** `do` in **Repeat Item** → rename **Do**
- **Get Dictionary Value** `value` in **Repeat Item** → rename **Value**
- **Get Dictionary Value** `text` in **Repeat Item** → rename **Text**
- **Get Dictionary Value** `who` in **Repeat Item** → rename **Who**
- **Get Dictionary Value** `url` in **Repeat Item** → rename **URL**
- **Get Dictionary Value** `when` in **Repeat Item** → rename **When**

Then add one **If** per row, one after another (not nested inside each other). Each is
**If Do is `<word>`** → the action → **End If**.

| If Do is | Action inside the If |
|---|---|
| `next` | **Skip Forward** |
| `previous` | **Skip Back** |
| `pause` | **Play/Pause**, set to **Pause** |
| `play` | **Play/Pause**, set to **Play** |
| `volume` | **Set Volume** to **Value** (see note 1) |
| `brightness` | **Set Brightness** to **Value** (see note 1) |
| `flashlight` | **If Text is `on`** → **Set Flashlight** Turn **On**; Otherwise → **Set Flashlight** Turn **Off** |
| `focus` | **If Text is `on`** → **Set Focus** Turn **Do Not Disturb** **On**; Otherwise → Turn it **Off** |
| `timer` | **Start Timer** for **Value** **seconds** |
| `alarm` | **Create Alarm** at **Text**, label `Alfred` |
| `reminder` | **If When has any value** → **Add New Reminder** **Text**, Alert **When**; Otherwise → **Add New Reminder** **Text** |
| `message` | **Find Contacts** where Name **contains** **Who**, Limit **on**, 1 → **Send Message** **Text** to **Contacts**. Tap the arrow and turn **Show When Run** off |
| `call` | **Find Contacts** where Name **contains** **Who**, Limit 1 → **Call** **Contacts** |
| `open` | **Open URLs** **URL** |

You don't have to build every row today. Start with `next`, `previous`, `pause`, `play`,
`volume`; anything Alfred returns that has no block simply does nothing.

**Note 1: volume and brightness.** Alfred sends 0-100. If "volume 30" jumps to full volume, put a
**Calculate** **Value ÷ 100** right before **Set Volume** / **Set Brightness** and use its result.

Run it once from the Shortcuts app and say "pause". iOS asks for permission the first time it
reaches the Worker, contacts, messages and so on: choose **Always Allow**.

## 3. Say "Hey Alfred" (no Siri)

Needs iOS 18 or later.

Settings → **Accessibility** → **Vocal Shortcuts** → **Add Action** → **Shortcut** → **Alfred**
→ say **"Hey Alfred"** three times when asked.

Now: "Hey Alfred" → (short pause, it starts listening) → "skip this song".

Also works without setup: **"Hey Siri, Alfred"**, since the shortcut is named Alfred. You can put
it on the **Action Button** (Settings → Action Button → Shortcut) or **Back Tap** (Accessibility →
Touch → Back Tap).

## 4. Instant commands (optional, no internet needed)

The main shortcut takes about a second or two to think. For the ones you use most, make tiny
shortcuts that skip the thinking, and give each a Vocal Shortcut phrase:

| Shortcut name | Its only action | Vocal Shortcut phrase |
|---|---|---|
| Alfred Next | **Skip Forward** | "Alfred next" |
| Alfred Back | **Skip Back** | "Alfred back" |
| Alfred Pause | **Play/Pause** → Pause | "Alfred pause" |
| Alfred Play | **Play/Pause** → Play | "Alfred play" |

Pick phrases that don't start with "Hey Alfred" so iOS doesn't confuse them with the main one.

## If something's off

- **It says "my brain isn't answering":** the Worker's AI call failed (or the free daily
  allowance ran out). `npx wrangler tail` on your computer shows the error live.
- **Nothing happens and nothing is said:** open the shortcut, tap ▶︎, and watch which action
  stops. Usually the URL, or the `Authorization` header is missing the word `Bearer `.
- **Music pauses while you talk and stays paused after "skip":** dictation can take over the
  audio. Add a **Play/Pause** → **Play** inside the `next` and `previous` blocks after the skip.
- **Wrong contact:** Find Contacts matches the first name that contains what you said. Say the
  name as it is saved, or add nicknames in Contacts.
