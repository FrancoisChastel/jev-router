import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  installService,
  launchdPlist,
  SERVICE_LABEL,
  type ServiceDeps,
  type ServiceSpec,
  serviceState,
  systemdUnit,
  uninstallService,
} from "../../src/cli/service";

const spec: ServiceSpec = {
  execPath: "/usr/local/bin/node",
  cliPath: "/opt/jev/dist/cli/index.js",
  port: 4141,
  logPath: "/home/u/.jev-router/relay.log",
  env: { HOME: "/home/u", PATH: "/usr/bin:/bin", JEV_ROUTER_HOME: "/home/u/.jev-router" },
};

function fakeDeps(platform: NodeJS.Platform, results: Record<string, CommandResult> = {}) {
  const calls: string[] = [];
  const files: Record<string, string> = {};
  const deps: ServiceDeps = {
    platform,
    homeDir: "/home/u",
    uid: 501,
    run: async (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      calls.push(key);
      return results[key] ?? { code: 0, stdout: "", stderr: "" };
    },
    writeFile: async (path, content) => {
      files[path] = content;
    },
    removeFile: async (path) => {
      delete files[path];
    },
  };
  return { deps, calls, files };
}

describe("service files", () => {
  test("launchd plist runs the CLI with the port, keeps it alive, and escapes XML", () => {
    const plist = launchdPlist({ ...spec, cliPath: "/a&b/cli.js" });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/a&amp;b/cli.js</string>");
    expect(plist).toContain("<string>up</string>\n    <string>--port</string>\n    <string>4141</string>");
    expect(plist).toContain("<key>JEV_ROUTER_HOME</key>\n    <string>/home/u/.jev-router</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toMatch(/sk-|API_KEY/);
  });
  test("systemd unit restarts on failure and logs to the relay log", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/jev/dist/cli/index.js" up --port 4141');
    expect(unit).toContain('Environment="HOME=/home/u"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StandardOutput=append:/home/u/.jev-router/relay.log");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("service lifecycle", () => {
  test("macOS: writes the agent, reloads it, and reports state from launchctl print", async () => {
    const { deps, calls, files } = fakeDeps("darwin", {
      [`launchctl print gui/501/${SERVICE_LABEL}`]: { code: 0, stdout: "state = running\n", stderr: "" },
    });
    const r = await installService(spec, deps);
    expect(r).toMatchObject({ ok: true, path: `/home/u/Library/LaunchAgents/${SERVICE_LABEL}.plist` });
    expect(files[r.path ?? ""]).toContain("<plist");
    expect(calls).toEqual([
      `launchctl bootout gui/501/${SERVICE_LABEL}`,
      `launchctl bootstrap gui/501 /home/u/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    ]);
    expect(await serviceState(deps)).toBe("running");
    const gone = await uninstallService(deps);
    expect(gone.ok).toBe(true);
    expect(files).toEqual({});
  });
  test("macOS: a failed bootstrap is reported, not hidden", async () => {
    const { deps } = fakeDeps("darwin", {
      [`launchctl bootstrap gui/501 /home/u/Library/LaunchAgents/${SERVICE_LABEL}.plist`]: {
        code: 5,
        stdout: "",
        stderr: "Input/output error",
      },
    });
    expect(await installService(spec, deps)).toMatchObject({ ok: false, detail: expect.stringContaining("Input/output error") });
    const { deps: none } = fakeDeps("darwin", {
      [`launchctl print gui/501/${SERVICE_LABEL}`]: { code: 113, stdout: "", stderr: "Could not find service" },
    });
    expect(await serviceState(none)).toBe("not-installed");
  });
  test("linux: writes the user unit and enables it; other platforms are unsupported", async () => {
    const { deps, calls, files } = fakeDeps("linux", {
      "systemctl --user is-active jev-router.service": { code: 0, stdout: "active\n", stderr: "" },
    });
    const r = await installService(spec, deps);
    expect(r).toMatchObject({ ok: true, path: "/home/u/.config/systemd/user/jev-router.service" });
    expect(files[r.path ?? ""]).toContain("[Service]");
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now jev-router.service"]);
    expect(await serviceState(deps)).toBe("running");
    const { deps: win } = fakeDeps("win32");
    expect((await installService(spec, win)).ok).toBe(false);
    expect(await serviceState(win)).toBe("unsupported");
  });
});
