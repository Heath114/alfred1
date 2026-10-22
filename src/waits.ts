// "Do the rest when they answer." Pending waits are kept in ~/Alfred/waiting.json (so a restart
// doesn't lose them) and checked against the Messages database every few seconds.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hands, Waiting } from "./tools.ts";

const DAY = 24 * 60 * 60 * 1000;

export function waits(
  folder: string,
  hands: Hands,
  on: { onReply(w: Waiting, reply: string): Promise<void>; onGiveUp(w: Waiting): Promise<void> },
  log: (e: object) => void,
  settleMs = 800, // Messages fills in a new row a moment after inserting it
) {
  const file = join(folder, "waiting.json");
  let list: Waiting[] = [];
  let loaded = false;
  let checking = false;

  const load = async () => {
    if (loaded) return;
    list = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
    loaded = true;
  };
  const save = () => writeFile(file, JSON.stringify(list, null, 2));

  return {
    async add(w: Waiting) {
      await load();
      list.push(w);
      await save();
      log({ waiting_for: w.contact, then: w.then });
    },
    async pending() {
      await load();
      return [...list];
    },
    // One pass: hand every wait that got a reply to onReply, drop the ones older than a day.
    async check(now = Date.now()) {
      if (checking) return;
      checking = true;
      try {
        await load();
        for (const w of [...list]) {
          let replies = await hands.repliesAfter(w.handles, w.afterId, w.since);
          if (replies.length && settleMs) {
            await new Promise((r) => setTimeout(r, settleMs));
            replies = await hands.repliesAfter(w.handles, w.afterId, w.since);
          }
          const expired = !replies.length && now - Date.parse(w.since) > DAY;
          if (!replies.length && !expired) continue;
          list = list.filter((x) => x !== w);
          await save();
          const handled = expired
            ? (log({ gave_up_waiting_for: w.contact, then: w.then }), on.onGiveUp(w))
            : on.onReply(w, replies.map((r) => r.text).join("\n"));
          await handled.catch((err) => log({ error: String(err), waiting_for: w.contact }));
        }
      } finally {
        checking = false;
      }
    },
  };
}
