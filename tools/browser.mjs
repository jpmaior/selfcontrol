#!/usr/bin/env node
// Drives a real Firefox with this extension installed, on a virtual display, so
// the hand checkpoints in PLAN.md and TODO.md can be run — and screenshotted —
// on a machine with no desktop, by an agent or by anyone else.
//
//   nix develop .#browser --command node tools/browser.mjs <command> [args]
//
// `start` launches Xvfb, a null audio sink and Firefox, then returns. Every
// other command connects over WebDriver BiDi, does one thing and disconnects,
// so the browser outlives them. Everything it keeps is in .browser/.
//
// Choices that look arbitrary:
// - A virtual display, not --headless: headless has no toolbar, so no badge
//   and no real popup, and the checkpoints look at both.
// - --remote-allow-system-access: reading the moz-extension UUID, pinning the
//   button and terminating the event page all need the browser's own window.
// - The add-on is installed temporarily, as about:debugging does, because
//   release Firefox refuses unsigned ones otherwise. A temporary add-on is
//   uninstalled at every shutdown, hence the keep*OnUninstall prefs below.
// - Nothing attaches devtools. An open console pins the event page alive; the
//   extension's console output reaches `log` through stdout instead.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node tools/browser.mjs <command>   (inside \`nix develop .#browser\`)

  start [--fresh] [--size WxH]  launch; --fresh wipes the profile, storage included
  stop                          quit Firefox cleanly, then the display and audio
  status                        what is running, the event page's state, the tabs
  reload                        reinstall from ./extension; like about:debugging's
                                Reload, it also clears storage.session
  open <target> [--new-tab]     a URL, a bare host, popup | options | blocked[?query],
                                or /path inside the extension
  shot [file] [--page]          PNG of the whole screen: toolbar, badge, popup.
                                --page: only the active tab's viewport
  popup                         click the toolbar button, opening the real popup
  eval <expr> [--bg]            evaluate in the active tab, print the JSON. --bg: in
                                the event page instead (dumpUsage(), setLimits()…),
                                which wakes it
  chrome <expr>                 evaluate in the browser window, with chrome privileges
  terminate                     terminate the event page, like about:debugging;
                                storage.session survives
  log [-n N] [--all]            the extension's console output, last 40 lines;
                                --all: everything Firefox printed
  xdo <args…>                   xdotool on the virtual display: xdo key Escape`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "extension");
const DIR = path.join(ROOT, ".browser");
const PROFILE = path.join(DIR, "profile");
const STATE = path.join(DIR, "state.json");
const LOG = path.join(DIR, "firefox.log");
const PULSE_DIR = path.join(DIR, "pulse");
const PULSE_SOCKET = path.join(PULSE_DIR, "native");

const EXT_ID = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"))
  .browser_specific_settings.gecko.id;
// Firefox's makeWidgetId(): the toolbar button's DOM id derives from the add-on id.
const BUTTON_ID = `${EXT_ID.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-browser-action`;

const PREFS = {
  // Nothing between start and the first command: no welcome tab, no
  // default-browser prompt, no crash-restore page after a kill.
  "browser.aboutwelcome.enabled": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "browser.startup.page": 0,
  "browser.sessionstore.resume_from_crash": false,
  "browser.tabs.warnOnClose": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "datareporting.healthreport.uploadEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  // Nobody is there to click play.
  "media.autoplay.default": 0,
  // The extension's console.log lines go to stdout, which `log` reads.
  "devtools.console.stdout.content": true,
  // Without these, the uninstall every shutdown implies would take the ledger
  // with it, and a new moz-extension UUID would orphan storage anyway.
  "extensions.webextensions.keepStorageOnUninstall": true,
  "extensions.webextensions.keepUuidOnUninstall": true,
};

const q = JSON.stringify;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- processes -------------------------------------------------------------

function requireTools(names) {
  const dirs = (process.env.PATH ?? "").split(":");
  const missing = names.filter((n) => !dirs.some((d) => fs.existsSync(path.join(d, n))));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not found — run this inside \`nix develop .#browser\``);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemon(cmd, args, logFile, env = {}) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}

async function waitFor(check, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function freeDisplay() {
  for (let n = 99; n < 200; n++) if (!fs.existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
  throw new Error("no free X display between :99 and :199");
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null);
const writeState = (state) => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

function requireRunning() {
  const state = readState();
  if (!state || !alive(state.firefoxPid)) throw new Error("the browser is not running — `start` it");
  return state;
}

// --- WebDriver BiDi ----------------------------------------------------------

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`nothing is listening for BiDi on port ${port}`));
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const call = pending.get(msg.id);
    if (!call) return; // an event; nothing here subscribes
    pending.delete(msg.id);
    if (msg.type === "error") call.reject(new Error(`${call.method}: ${msg.error}: ${msg.message}`));
    else call.resolve(msg.result);
  };
  ws.onclose = () => {
    for (const call of pending.values()) call.reject(new Error(`${call.method}: connection closed`));
    pending.clear();
  };

  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error(`${method}: connection closed`));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const end = async () => {
    await send("session.end").catch(() => {});
    ws.close();
  };

  try {
    await send("session.new", { capabilities: {} });
  } catch (err) {
    ws.close();
    // Firefox allows one session, keeps it when its connection drops, and
    // offers no way to reattach to one opened over BiDi alone.
    if (/Maximum number of active sessions/.test(err.message)) {
      throw new Error("a command killed halfway left its session open, and Firefox never releases it — `stop` and `start` again");
    }
    throw err;
  }
  return { send, end };
}

async function withBrowser(fn, state = requireRunning()) {
  const b = await connect(state.port);
  // Interrupted, still end the session: see connect().
  const bail = () => b.end().finally(() => process.exit(130));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.once(s, bail);
  try {
    return await fn(b);
  } finally {
    for (const s of signals) process.off(s, bail);
    await b.end();
  }
}

async function evaluate(b, context, expression) {
  const r = await b.send("script.evaluate", { expression, target: { context }, awaitPromise: true });
  if (r.type === "exception") throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

/** Wraps a user's expression so the page serializes its own answer. */
function wrap(expr, inBackground = false) {
  // `with` resolves bare names in the event page's global, so `dumpUsage()`
  // reads exactly as it would typed into its console.
  const value = inBackground
    ? `await (async function () { with (await browser.runtime.getBackgroundPage()) return await (${expr}\n); })()`
    : `await (${expr}\n)`;
  return `(async () => {
    const v = ${value};
    if (v === undefined) return "undefined";
    try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
  })()`;
}

async function chromeWindow(b) {
  const { contexts } = await b.send("browsingContext.getTree", { "moz:scope": "chrome" });
  const win = contexts.find((c) => c.url === "chrome://browser/content/browser.xhtml");
  if (!win) throw new Error("no browser window");
  return win.context;
}

/** The selected tab: the only top-level document Firefox reports as visible. */
async function activeTab(b) {
  const { contexts } = await b.send("browsingContext.getTree", { maxDepth: 0 });
  for (const { context } of contexts) {
    const r = await b
      .send("script.evaluate", { expression: "document.visibilityState", target: { context }, awaitPromise: false })
      .catch(() => null);
    if (r?.result?.value === "visible") return context;
  }
  return contexts[0].context;
}

/** A tab showing one of our pages, where `browser.*` exists; opened in the background if need be. */
async function extensionTab(b, uuid) {
  const { contexts } = await b.send("browsingContext.getTree", { maxDepth: 0 });
  const found = contexts.find((c) => c.url.startsWith(`moz-extension://${uuid}/`));
  if (found) return { context: found.context, opened: false };
  const { context } = await b.send("browsingContext.create", { type: "tab", background: true });
  await b.send("browsingContext.navigate", { context, url: `moz-extension://${uuid}/options/options.html`, wait: "complete" });
  return { context, opened: true };
}

async function install(b, { width, height }) {
  await b.send("webExtension.install", { extensionData: { type: "path", path: EXT_DIR } });
  const win = await chromeWindow(b);
  return evaluate(
    b,
    win,
    `(async () => {
      for (let i = 0; i < 50 && !CustomizableUI.getWidget(${q(BUTTON_ID)})?.instances.length; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // New extensions land in the overflow menu; the checkpoints look at the badge.
      CustomizableUI.addWidgetToArea(${q(BUTTON_ID)}, CustomizableUI.AREA_NAVBAR);
      // With no window manager Firefox picks its own size; fill the screen.
      window.moveTo(0, 0);
      window.resizeTo(${width}, ${height});
      return WebExtensionPolicy.getByID(${q(EXT_ID)}).mozExtensionHostname;
    })()`,
  );
}

function resolveUrl(target, uuid) {
  const page = /^(popup|options|blocked)(\?.*)?$/.exec(target);
  if (page) return `moz-extension://${uuid}/${page[1]}/${page[1]}.html${page[2] ?? ""}`;
  if (target.startsWith("/")) return `moz-extension://${uuid}${target}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  return `https://${target}`;
}

// --- commands ----------------------------------------------------------------

const commands = {
  async start(args) {
    requireTools(["firefox", "Xvfb", "pulseaudio", "xdotool", "import"]);
    const running = readState();
    if (running && alive(running.firefoxPid)) {
      console.log(`already running on DISPLAY=${running.display}`);
      return;
    }
    // Firefox died on its own; do not leave its display and sink behind.
    for (const pid of [running?.pulsePid, running?.xvfbPid]) if (pid && alive(pid)) process.kill(pid, "SIGTERM");
    if (args.includes("--fresh")) fs.rmSync(PROFILE, { recursive: true, force: true });
    const [width, height] = (option(args, "--size") ?? "1280x800").split("x").map(Number);

    fs.mkdirSync(PROFILE, { recursive: true });
    fs.mkdirSync(PULSE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROFILE, "user.js"),
      Object.entries(PREFS).map(([k, v]) => `user_pref(${q(k)}, ${q(v)});\n`).join(""),
    );

    const display = freeDisplay();
    // -dpi 96: otherwise Xvfb reports ~99 and Firefox scales everything by
    // 99/96, so a pixel in a screenshot is no longer a CSS pixel to click on.
    const xvfbPid = daemon(
      "Xvfb",
      [display, "-screen", "0", `${width}x${height}x24`, "-dpi", "96", "-nolisten", "tcp"],
      path.join(DIR, "xvfb.log"),
    );
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), "Xvfb");

    fs.rmSync(PULSE_SOCKET, { force: true });
    const pulsePid = daemon(
      "pulseaudio",
      [
        "--daemonize=no",
        "--exit-idle-time=-1",
        "--use-pid-file=no",
        "--realtime=no",
        "--high-priority=no",
        "-n", // no default.pa: nothing but these two modules
        `--load=module-native-protocol-unix socket=${PULSE_SOCKET} auth-anonymous=1`,
        "--load=module-null-sink sink_name=null",
      ],
      path.join(DIR, "pulse.log"),
      // Its state stays here, not in ~/.config/pulse.
      { PULSE_STATE_PATH: PULSE_DIR, PULSE_RUNTIME_PATH: PULSE_DIR },
    );
    await waitFor(() => fs.existsSync(PULSE_SOCKET), "PulseAudio");

    const port = await freePort();
    fs.appendFileSync(LOG, `${new Date().toTimeString().slice(0, 8)} --- browser started ---\n`);
    // Timestamps every line: the checkpoints reason about when things happened,
    // and Firefox's console output carries no time of its own. bash execs into
    // Firefox, so the pid we keep is Firefox's.
    const stamp = `exec > >(while IFS= read -r l; do printf '%(%H:%M:%S)T %s\\n' -1 "$l"; done >> "$0") 2>&1; exec "$@"`;
    const firefoxPid = daemon(
      "bash",
      ["-c", stamp, LOG, "firefox", "--profile", PROFILE, "--no-remote",
        "--remote-debugging-port", String(port), "--remote-allow-system-access"],
      "/dev/null",
      { DISPLAY: display, PULSE_SERVER: `unix:${PULSE_SOCKET}` },
    );
    const state = { display, port, width, height, xvfbPid, pulsePid, firefoxPid };
    writeState(state);
    await waitFor(() => fs.readFileSync(LOG, "utf8").includes(`ws://127.0.0.1:${port}`), "Firefox", 60_000);

    state.uuid = await withBrowser((b) => install(b, state), state);
    writeState(state);
    console.log(`running on DISPLAY=${display}, BiDi port ${port}`);
    console.log(`extension ${EXT_ID} at moz-extension://${state.uuid}/`);
  },

  async stop() {
    const state = readState();
    if (!state) return console.log("not running");
    if (alive(state.firefoxPid)) {
      // A clean quit, so storage is flushed the way it is for a user.
      await withBrowser((b) => b.send("browser.close"), state).catch(() =>
        process.kill(state.firefoxPid, "SIGTERM"),
      );
      await waitFor(() => !alive(state.firefoxPid), "Firefox to quit", 15_000).catch(() =>
        process.kill(state.firefoxPid, "SIGKILL"),
      );
    }
    for (const pid of [state.pulsePid, state.xvfbPid]) if (alive(pid)) process.kill(pid, "SIGTERM");
    fs.rmSync(STATE);
    console.log("stopped");
  },

  async status() {
    const state = requireRunning();
    const info = await withBrowser(async (b) =>
      JSON.parse(
        await evaluate(
          b,
          await chromeWindow(b),
          `JSON.stringify({
            background: WebExtensionPolicy.getByID(${q(EXT_ID)})?.extension?.backgroundState ?? "not installed",
            tabs: gBrowser.tabs.map((t) => ({
              selected: t.selected, audible: t.soundPlaying, muted: t.muted,
              url: t.linkedBrowser.currentURI.spec, title: t.label,
            })),
          })`,
        ),
      ),
    );
    console.log(`DISPLAY=${state.display}, BiDi port ${state.port}, moz-extension://${state.uuid}/`);
    console.log(`event page: ${info.background}`);
    for (const t of info.tabs) {
      const flags = [t.audible && "audible", t.muted && "muted"].filter(Boolean).join(",");
      console.log(`${t.selected ? "*" : " "} ${flags ? `[${flags}] ` : ""}${t.url}  ${t.title}`);
    }
  },

  async reload() {
    const state = requireRunning();
    state.uuid = await withBrowser((b) => install(b, state), state);
    writeState(state);
    console.log(`reinstalled from ${EXT_DIR}`);
  },

  async open(args) {
    const target = args.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("open what?");
    const { uuid } = requireRunning();
    const url = resolveUrl(target, uuid);
    await withBrowser(async (b) => {
      const context = args.includes("--new-tab")
        ? (await b.send("browsingContext.create", { type: "tab" })).context
        : await activeTab(b);
      const nav = await b.send("browsingContext.navigate", { context, url, wait: "complete" }, 60_000);
      const title = await evaluate(b, context, "document.title").catch(() => "");
      console.log(`${nav.url}  ${title}`);
    });
  },

  async shot(args) {
    const state = requireRunning();
    const name = args.find((a) => !a.startsWith("--"));
    const file = path.resolve(name ?? path.join(DIR, "shots", `${new Date().toISOString().replace(/[:.]/g, "-")}.png`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (args.includes("--page")) {
      await withBrowser(async (b) => {
        const { data } = await b.send("browsingContext.captureScreenshot", { context: await activeTab(b) });
        fs.writeFileSync(file, Buffer.from(data, "base64"));
      });
    } else {
      execFileSync("import", ["-window", "root", file], { env: { ...process.env, DISPLAY: state.display } });
    }
    console.log(file);
  },

  async popup() {
    const state = requireRunning();
    const { x, y } = await withBrowser(async (b) =>
      JSON.parse(
        await evaluate(
          b,
          await chromeWindow(b),
          `(() => {
            const r = document.getElementById(${q(BUTTON_ID)}).getBoundingClientRect();
            return JSON.stringify({
              x: Math.round((window.mozInnerScreenX + r.x + r.width / 2) * devicePixelRatio),
              y: Math.round((window.mozInnerScreenY + r.y + r.height / 2) * devicePixelRatio),
            });
          })()`,
        ),
      ),
    );
    // A real click rather than a scripted one: the button opens its popup on
    // mousedown, and a synthetic click() never gets there.
    execFileSync("xdotool", ["mousemove", String(x), String(y), "click", "1"], {
      env: { ...process.env, DISPLAY: state.display },
    });
    await sleep(1000);
    console.log(`clicked the toolbar button at ${x},${y}; \`xdo key Escape\` closes the popup`);
  },

  async eval(args) {
    const expr = args.find((a) => a !== "--bg");
    if (!expr) throw new Error("evaluate what?");
    const { uuid } = requireRunning();
    await withBrowser(async (b) => {
      if (!args.includes("--bg")) return console.log(await evaluate(b, await activeTab(b), wrap(expr)));
      const tab = await extensionTab(b, uuid);
      try {
        console.log(await evaluate(b, tab.context, wrap(expr, true)));
      } finally {
        if (tab.opened) await b.send("browsingContext.close", { context: tab.context });
      }
    });
  },

  async chrome(args) {
    if (!args[0]) throw new Error("evaluate what?");
    await withBrowser(async (b) => console.log(await evaluate(b, await chromeWindow(b), wrap(args[0]))));
  },

  async terminate() {
    await withBrowser(async (b) =>
      console.log(
        await evaluate(
          b,
          await chromeWindow(b),
          `(async () => {
            const ext = WebExtensionPolicy.getByID(${q(EXT_ID)})?.extension;
            if (!ext) return "not installed";
            await ext.terminateBackground();
            return "event page " + ext.backgroundState;
          })()`,
        ),
      ),
    );
  },

  async log(args) {
    const n = Number(option(args, "-n") ?? 40);
    const lines = fs
      .readFileSync(LOG, "utf8")
      .split("\n")
      // By default only log.js's prefixed lines and anything naming our pages:
      // Firefox and every open site write to the same stdout.
      .filter((l) => l && (args.includes("--all") || / --- |"%c\[|moz-extension:\/\//.test(l)))
      .map((l) =>
        l
          // log.js styles its prefix with %c; the style string is noise here.
          .replace(/"%c([^"]*)" "[^"]*" /, "$1 ")
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      );
    console.log(lines.slice(-n).join("\n"));
  },

  async xdo(args) {
    const { display } = requireRunning();
    execFileSync("xdotool", args, { stdio: "inherit", env: { ...process.env, DISPLAY: display } });
  },
};

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
try {
  await commands[command](rest);
} catch (err) {
  console.error(`browser ${command}: ${err.message}`);
  process.exit(1);
}
