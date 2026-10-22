// What setup installs on the Mac, as data: Alfred.app's Info.plist and the LaunchAgents.
import { join } from "node:path";
import { paths } from "./paths.ts";
import { toPlist } from "./plist.ts";

export const LABELS = { alfred: "com.alfred.agent", bark: "com.alfred.bark", watchdog: "com.alfred.watchdog" };

export function appInfoPlist(): string {
  return toPlist({
    CFBundleIdentifier: "com.alfred.agent",
    CFBundleName: "Alfred",
    CFBundleDisplayName: "Alfred",
    CFBundleExecutable: "Alfred",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: "1.0",
    CFBundleVersion: "1",
    LSMinimumSystemVersion: "13.0",
    LSUIElement: true, // no Dock icon
    // Shown when macOS asks whether Alfred may control Messages and Reminders.
    NSAppleEventsUsageDescription: "Alfred sends messages and adds reminders for you when you ask it to.",
  });
}

const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// Alfred's server, started through Alfred.app so the permissions belong to the app.
export function alfredAgent(opts: { node: string; appDir: string; uid: number }): string {
  return toPlist({
    Label: LABELS.alfred,
    ProgramArguments: [
      join(paths.app, "Contents", "MacOS", "Alfred"),
      opts.node,
      "--disable-warning=ExperimentalWarning",
      `--env-file=${join(opts.appDir, ".env")}`,
      join(opts.appDir, "src", "server.ts"),
    ],
    WorkingDirectory: opts.appDir,
    EnvironmentVariables: { PATH, LANG: "en_US.UTF-8" },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ProcessType: "Interactive", // no background throttling
    LimitLoadToSessionType: "Aqua", // the logged-in desktop session, where Messages runs
    StandardOutPath: join(paths.logs, "server.log"),
    StandardErrorPath: join(paths.logs, "server.log"),
  });
}

// bark-server reads its settings from the environment (names checked against the binary).
export function barkAgent(opts: { server: string; dataDir: string }): string {
  return toPlist({
    Label: LABELS.bark,
    ProgramArguments: [opts.server],
    EnvironmentVariables: { BARK_SERVER_ADDRESS: "127.0.0.1:8080", BARK_SERVER_DATA_DIR: opts.dataDir },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    StandardOutPath: join(paths.logs, "bark.log"),
    StandardErrorPath: join(paths.logs, "bark.log"),
  });
}

// launchd can stop restarting a job that crashed many times in a row; this starts it again every
// five minutes if it isn't running (kickstart without -k leaves a running job alone).
export function watchdogAgent(uid: number): string {
  return toPlist({
    Label: LABELS.watchdog,
    ProgramArguments: ["/bin/launchctl", "kickstart", `gui/${uid}/${LABELS.alfred}`],
    StartInterval: 300,
    RunAtLoad: false,
    ProcessType: "Background",
  });
}
