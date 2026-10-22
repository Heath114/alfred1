// XML property lists, for the Shortcuts, Alfred.app's Info.plist and the LaunchAgents.
// Shortcuts get converted to binary with plutil before signing.
export function toPlist(value: unknown): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const write = (v: unknown, pad: string): string => {
    if (typeof v === "string") return `${pad}<string>${esc(v)}</string>`;
    if (typeof v === "boolean") return `${pad}<${v}/>`;
    if (typeof v === "number") return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`;
    if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map((x) => write(x, pad + "\t")).join("\n")}\n${pad}</array>` : `${pad}<array/>`;
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (!entries.length) return `${pad}<dict/>`;
      return `${pad}<dict>\n${entries.map(([k, x]) => `${pad}\t<key>${esc(k)}</key>\n${write(x, pad + "\t")}`).join("\n")}\n${pad}</dict>`;
    }
    throw new Error(`Can't put ${String(v)} in a plist`);
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${write(value, "")}
</plist>
`;
}
