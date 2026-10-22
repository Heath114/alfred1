// Where Alfred keeps things on the Mac. Note: macOS folders are case-insensitive by default, so
// "~/alfred" and "~/Alfred" are the same folder; the code lives in the hidden ~/.alfred instead.
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const paths = {
  files: process.env.ALFRED_FOLDER || join(home, "Alfred"), // yours: people.json and what Alfred saves
  state: process.env.ALFRED_STATE || join(home, ".alfred"), // code, runtime, Telegram login, pending waits
  logs: join(home, "Library", "Logs", "Alfred"),
  app: join(home, "Applications", "Alfred.app"), // holds macOS permissions; see mac/wrapper.c
  launchAgents: join(home, "Library", "LaunchAgents"),
};
