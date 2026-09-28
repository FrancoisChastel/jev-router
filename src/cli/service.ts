/**
 * Run the relay as a per-user background service so nobody has to keep a terminal open: a launchd agent on macOS,
 * a systemd user unit on Linux. The service runs `jev-router up`, which reads the judge key from the env file.
 */

export const SERVICE_LABEL = "ai.jev-router.relay";
export const SYSTEMD_UNIT = "jev-router.service";

export interface ServiceSpec {
  /** Node binary and CLI entry the service runs. */
  readonly execPath: string;
  readonly cliPath: string;
  readonly port: number;
  readonly logPath: string;
  /** Environment for the relay process: HOME, PATH, JEV_ROUTER_HOME when set. Never secrets. */
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceDeps {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number;
  readonly run: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
}

export type ServiceState = "running" | "stopped" | "not-installed" | "unsupported";

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.execPath, spec.cliPath, "up", "--port", String(spec.port)];
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>\n  <string>${SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}\n  </array>`,
    `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    "  <key>KeepAlive</key>\n  <true/>",
    `  <key>StandardOutPath</key>\n  <string>${xml(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(spec.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function systemdUnit(spec: ServiceSpec): string {
  const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
    .join("\n");
  return [
    "[Unit]",
    "Description=jev-router relay",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${q(spec.execPath)} ${q(spec.cliPath)} up --port ${spec.port}`,
    env,
    "Restart=on-failure",
    "RestartSec=2",
    `StandardOutput=append:${spec.logPath}`,
    `StandardError=append:${spec.logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function servicePath(deps: Pick<ServiceDeps, "platform" | "homeDir">): string | undefined {
  if (deps.platform === "darwin") return `${deps.homeDir}/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
  if (deps.platform === "linux") return `${deps.homeDir}/.config/systemd/user/${SYSTEMD_UNIT}`;
  return undefined;
}

export interface ServiceOutcome {
  readonly ok: boolean;
  readonly path?: string;
  readonly detail: string;
}

export async function installService(spec: ServiceSpec, deps: ServiceDeps): Promise<ServiceOutcome> {
  const path = servicePath(deps);
  if (!path) return { ok: false, detail: `no service manager integration for ${deps.platform}; run 'jev-router up' yourself` };
  if (deps.platform === "darwin") {
    await deps.writeFile(path, launchdPlist(spec));
    await deps.run("launchctl", ["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
    const r = await deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, path]);
    if (r.code !== 0) return { ok: false, path, detail: `launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}` };
    return { ok: true, path, detail: "launchd agent loaded; it starts at login and restarts if it exits" };
  }
  await deps.writeFile(path, systemdUnit(spec));
  const reload = await deps.run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) return { ok: false, path, detail: `systemctl daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}` };
  const enable = await deps.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  if (enable.code !== 0) return { ok: false, path, detail: `systemctl enable failed: ${(enable.stderr || enable.stdout).trim()}` };
  return { ok: true, path, detail: "systemd user unit enabled; it starts at login and restarts on failure" };
}

export async function uninstallService(deps: ServiceDeps): Promise<ServiceOutcome> {
  const path = servicePath(deps);
  if (!path) return { ok: false, detail: `no service manager integration for ${deps.platform}` };
  if (deps.platform === "darwin") await deps.run("launchctl", ["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
  else {
    await deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    await deps.run("systemctl", ["--user", "daemon-reload"]);
  }
  try {
    await deps.removeFile(path);
  } catch {
    /* already gone */
  }
  return { ok: true, path, detail: "service removed" };
}

export async function serviceState(deps: ServiceDeps): Promise<ServiceState> {
  if (deps.platform === "darwin") {
    const r = await deps.run("launchctl", ["print", `gui/${deps.uid}/${SERVICE_LABEL}`]);
    if (r.code !== 0) return "not-installed";
    return /state = running/.test(r.stdout) ? "running" : "stopped";
  }
  if (deps.platform === "linux") {
    const r = await deps.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    const out = r.stdout.trim();
    if (out === "active" || out === "activating") return "running";
    if (r.code === 4 || /could not be found|not-found|Unit .* not loaded/i.test(r.stderr + r.stdout)) return "not-installed";
    return "stopped";
  }
  return "unsupported";
}
