#!/usr/bin/env node
// The extension's console on Firefox for Android: run it on the emulator (or a
// phone), read what the event page logs, evaluate in it, suspend and wake it.
// The Android counterpart of tools/browser.mjs, so behaviour there is tested
// by an agent rather than by hand.
//
//   nix develop .#android --command node tools/android.mjs <command> [args]
//
// `start` boots the emulator if needed and leaves `web-ext run` going in the
// background; every other command connects to Firefox's remote debugging port
// (the one web-ext forwards over adb), does one thing and disconnects.
//
// Choices that look arbitrary:
// - The Remote Debugging Protocol, not logcat: Firefox for Android does not
//   send extension console output to logcat at all.
// - Two different handles on the extension. The add-on's *watcher* lists its
//   pages and their consoles, but while one is attached the event page is
//   never suspended (just like an open devtools console), and Firefox allows
//   only one at a time. The parent process's console reads and drives the
//   event page's lifecycle through WebExtensionPolicy without attaching
//   anything, so `status`, `wake` and `terminate` leave the page free to
//   suspend, and `eval` attaches only for as long as it takes.
// - `eval` wakes a stopped event page first: with nothing running, the watcher
//   only offers devtools' fallback document, where `browser` does not exist.
// - Taps, URLs and screenshots are not here: the dev shell has `tap-text`,
//   `ui-list` and `screenshot`, and T3 Code's Device panel drives the screen.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node tools/android.mjs <command>   (inside \`nix develop .#android\`)

  start               boot the emulator if no device is attached, then load the
                      extension with \`web-ext run\` (it reloads on every change)
  stop                stop web-ext, so edits are no longer reloaded. The add-on
                      stays loaded until Firefox restarts; the emulator keeps
                      running (\`emu-stop\`)
  status              the event page's state and the debugger port; attaches
                      nothing, so the page still suspends
  wake                start the event page, as any event would
  terminate           stop it, like about:debugging's Terminate Background
                      Script; storage.session survives
  reload              reinstall from ./extension, like about:debugging's
                      Reload; storage.session is cleared
  log                 what the extension has logged: the running event page
                      since it started, and any open extension page
  follow [seconds]    stream the extension's console, every page; keeps the
                      event page alive while it runs (Ctrl-C to stop)
  eval <expr> [--page <part-of-url>]
                      evaluate in the event page (woken first if stopped) and
                      print the JSON: eval 'dumpUsage()'. --page: in an open
                      extension page instead, e.g. --page options.html

  ANDROID_SERIAL picks the device when more than one is attached.`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "extension");
const DIR = path.join(ROOT, ".browser");
const STATE = path.join(DIR, "android.json");
const LOG = path.join(DIR, "android-web-ext.log");

const APK = "org.mozilla.firefox";
const DEBUGGER_SOCKET = `localabstract:${APK}/firefox-debugger-socket`;
const EXT_ID = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"))
  .browser_specific_settings.gecko.id;

const q = JSON.stringify;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- processes and devices ---------------------------------------------------

function requireTools(names) {
  const dirs = (process.env.PATH ?? "").split(":");
  const missing = names.filter((n) => !dirs.some((d) => fs.existsSync(path.join(d, n))));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not found — run this inside \`nix develop .#android\``);
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

async function waitFor(check, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" });

function devices() {
  return adb("devices")
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter(([, state]) => state === "device")
    .map(([serial]) => serial);
}

function device() {
  const all = devices();
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  if (all.length === 1) return all[0];
  throw new Error(all.length === 0 ? "no device attached — `start` boots the emulator" : `several devices (${all.join(", ")}): set ANDROID_SERIAL`);
}

/** The local port forwarded to Firefox's debugger socket, by web-ext or anyone. */
function debuggerPort(serial = device()) {
  const ports = adb("-s", serial, "forward", "--list")
    .split("\n")
    .filter((line) => line.endsWith(DEBUGGER_SOCKET))
    .map((line) => Number(line.split(" ")[1].replace("tcp:", "")));
  // Every web-ext run adds a forward; any of them reaches the same socket.
  if (ports.length === 0) throw new Error("no debugger port forwarded — `start` it");
  return ports.at(-1);
}

const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null);

// --- Remote Debugging Protocol --------------------------------------------------
//
// Packets are `<byte length>:<JSON>` both ways. Replies come from the actor
// addressed and carry no `type`; events carry one.

async function connect(port = debuggerPort()) {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", () => reject(new Error(`nothing is listening on port ${port}`)));
  });

  let buffer = Buffer.alloc(0);
  const waiters = [];
  const listeners = [];
  sock.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(":");
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
      buffer = buffer.subarray(colon + 1 + length);
      for (const listener of listeners) listener(packet);
      const i = waiters.findIndex((w) => w.match(packet));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(packet);
    }
  });

  function next(match, what, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i < 0) return;
        waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs).unref();
    });
  }

  async function request(to, type, extra = {}, what = type) {
    const reply = next((p) => p.from === to && (!p.type || p.error), what);
    const body = JSON.stringify({ to, type, ...extra });
    sock.write(`${Buffer.byteLength(body)}:${body}`);
    const packet = await reply;
    if (packet.error) throw new Error(`${type}: ${packet.error} ${packet.message ?? ""}`.trim());
    return packet;
  }

  await next((p) => p.from === "root", "Firefox's debugger to greet us");
  return { request, next, on: (listener) => listeners.push(listener), close: () => sock.destroy() };
}

async function withDebugger(fn) {
  const rdp = await connect();
  try {
    return await fn(rdp);
  } finally {
    rdp.close();
  }
}

/**
 * Like tools/browser.mjs's wrapper, the page serializes its own answer; here it
 * also catches its own errors, because the debugger reports a rejected
 * top-level await only as `topLevelAwaitRejected`, without the error.
 */
function wrap(expr) {
  return `(async () => {
    try {
      const v = await (${expr}
      );
      if (v === undefined) return JSON.stringify({ ok: "undefined" });
      try { return JSON.stringify({ ok: JSON.stringify(v, null, 2) ?? String(v) }); }
      catch { return JSON.stringify({ ok: String(v) }); }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? \`\${e.name}: \${e.message}\` : String(e) });
    }
  })()`;
}

async function evaluate(rdp, consoleActor, expr) {
  const result = rdp.next(
    (p) => p.type === "evaluationResult" && p.from === consoleActor,
    "the evaluation",
    60_000,
  );
  await rdp.request(consoleActor, "evaluateJSAsync", { text: wrap(expr), mapped: { await: true } });
  const r = await result;
  if (r.exceptionMessage) throw new Error(r.exceptionMessage);
  let answer = r.result;
  if (answer?.type === "longString") {
    answer = (await rdp.request(answer.actor, "substring", { start: 0, end: answer.length })).substring;
  }
  if (typeof answer !== "string") throw new Error(`no answer from the page (${JSON.stringify(r).slice(0, 200)})`);
  const { ok, error } = JSON.parse(answer);
  if (error) throw new Error(error);
  return ok;
}

/** Evaluate with chrome privileges in the parent process. Attaches to nothing. */
async function inParent(rdp, expr) {
  const { processDescriptor } = await rdp.request("root", "getProcess", { id: 0 });
  const { process: target } = await rdp.request(processDescriptor.actor, "getTarget");
  return JSON.parse(await evaluate(rdp, target.consoleActor, expr));
}

const POLICY = `WebExtensionPolicy.getByID(${q(EXT_ID)})?.extension`;
const backgroundState = (rdp) => inParent(rdp, `${POLICY}?.backgroundState ?? "not installed"`);

async function wake(rdp) {
  const state = await inParent(
    rdp,
    `(async () => {
      const ext = ${POLICY};
      if (!ext) return "not installed";
      if (ext.backgroundState !== "running") await ext.wakeupBackground();
      return ext.backgroundState;
    })()`,
  );
  if (state === "not installed") throw new Error("SelfControl is not installed — `start` it");
  await waitFor(async () => (await backgroundState(rdp)) === "running", "the event page to start");
}

/**
 * The add-on's watcher: its pages as debugging targets. Only one client can
 * hold it, and holding it keeps the event page alive.
 */
async function watch(rdp) {
  const { addons } = await rdp.request("root", "listAddons");
  const addon = addons.find((a) => a.id === EXT_ID);
  if (!addon) throw new Error("SelfControl is not installed — `start` it");
  const { actor } = await rdp.request(
    addon.actor,
    "getWatcher",
    { isServerTargetSwitchingEnabled: true },
    "the add-on's watcher (is a `follow` or about:debugging attached?)",
  );
  const targets = [];
  rdp.on((p) => {
    if (p.type === "target-available-form") targets.push(p.target);
    if (p.type === "target-destroyed-form") {
      const i = targets.findIndex((t) => t.actor === p.target?.actor);
      if (i >= 0) targets.splice(i, 1);
    }
  });
  await rdp.request(actor, "watchTargets", { targetType: "frame" });
  return { watcher: actor, addon, targets };
}

const isBackground = (target) => (target.url ?? "").endsWith("/_generated_background_page.html");

// --- console output ------------------------------------------------------------

function grip(value) {
  if (value === null || typeof value !== "object") return value;
  if (value.type === "undefined") return "undefined";
  if (value.type === "null") return null;
  if (value.type === "longString") return `${value.initial}…`;
  if (value.preview?.ownProperties) {
    return Object.fromEntries(
      Object.entries(value.preview.ownProperties).map(([k, d]) => [k, grip(d.value ?? d)]),
    );
  }
  if (value.preview?.items) return value.preview.items.map(grip);
  if (value.preview?.message) return `${value.preview.name}: ${value.preview.message}`;
  return `[${value.class ?? value.type}]`;
}

const clockTime = (ms) => new Date(ms).toTimeString().slice(0, 8);

function text(args) {
  let parts = args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(grip(a)) : String(a)));
  // log.js styles its prefix: "%c[selfcontrol]", "<css>", ...; the CSS is noise.
  if (parts[0]?.startsWith("%c")) parts = [parts[0].slice(2), ...parts.slice(2)];
  return parts.filter((p) => p !== "").join(" ");
}

function printResources(packet) {
  if (packet.type !== "resources-available-array") return;
  for (const [kind, list] of packet.array) {
    for (const r of list) {
      if (kind === "console-message") {
        const m = r.message ?? r;
        const level = m.level === "log" || m.level === "info" ? "" : `[${m.level}] `;
        console.log(`${clockTime(m.timeStamp)} ${level}${text(m.arguments ?? [])}`);
      } else if (kind === "error-message") {
        const e = r.pageError ?? r;
        const where = e.sourceName ? ` (${e.sourceName.split("/").slice(-2).join("/")}:${e.lineNumber})` : "";
        console.log(`${clockTime(e.timeStamp)} [${e.warning ? "warning" : "error"}] ${e.errorMessage}${where}`);
      }
    }
  }
}

const CONSOLE = { resourceTypes: ["console-message", "error-message"] };

// --- commands --------------------------------------------------------------------

const commands = {
  async start() {
    requireTools(["adb", "emulator", "web-ext", "emu-start"]);
    if (devices().length === 0) execFileSync("emu-start", { stdio: "inherit" });
    const serial = device();

    const running = readState();
    if (running && alive(running.webExtPid)) {
      console.log(`already running on ${running.serial}, debugger on port ${debuggerPort(running.serial)}`);
      return;
    }

    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOG, "");
    const out = fs.openSync(LOG, "a");
    const child = spawn(
      "web-ext",
      ["run", "--no-input", "-t", "firefox-android", "--adb-device", serial, "--firefox-apk", APK,
        "--source-dir", EXT_DIR, "--adb-remove-old-artifacts"],
      { detached: true, stdio: ["ignore", out, out] },
    );
    child.unref();
    fs.writeFileSync(STATE, JSON.stringify({ webExtPid: child.pid, serial }, null, 2));

    const log = () => fs.readFileSync(LOG, "utf8");
    try {
      await waitFor(
        () => /Installed .* as a temporary add-on/.test(log()) || !alive(child.pid),
        "web-ext to install the add-on",
        240_000,
      );
    } catch (err) {
      // web-ext waits forever, without saying why, until Firefox allows it in.
      if (/Waiting for .* Remote Debugging Server/.test(log())) {
        throw new Error(
          "Firefox is not accepting the connection: turn on ⋮ → Settings → Remote debugging via USB (docs/DEVELOPMENT.md)",
        );
      }
      throw err;
    }
    if (!alive(child.pid)) throw new Error(`web-ext exited — see ${path.relative(ROOT, LOG)}`);
    console.log(`installed on ${serial}, debugger on port ${debuggerPort(serial)}; web-ext reloads it on every change`);
  },

  async stop() {
    const state = readState();
    if (!state || !alive(state.webExtPid)) {
      fs.rmSync(STATE, { force: true });
      return console.log("web-ext is not running");
    }
    process.kill(state.webExtPid, "SIGINT");
    await waitFor(() => !alive(state.webExtPid), "web-ext to exit", 15_000).catch(() =>
      process.kill(state.webExtPid, "SIGTERM"),
    );
    fs.rmSync(STATE, { force: true });
    console.log("web-ext stopped; the add-on stays loaded until Firefox restarts, the emulator until `emu-stop`");
  },

  async status() {
    const serial = device();
    const port = debuggerPort(serial);
    const state = await withDebugger(backgroundState);
    const webExt = readState();
    console.log(`device ${serial}, debugger on port ${port}`);
    console.log(`web-ext: ${webExt && alive(webExt.webExtPid) ? `running (pid ${webExt.webExtPid})` : "not started by this tool"}`);
    console.log(`event page: ${state}`);
  },

  async wake() {
    await withDebugger(wake);
    console.log("event page running");
  },

  async terminate() {
    console.log(
      "event page",
      await withDebugger((rdp) =>
        inParent(
          rdp,
          `(async () => {
            const ext = ${POLICY};
            if (!ext) return "not installed";
            await ext.terminateBackground();
            return ext.backgroundState;
          })()`,
        ),
      ),
    );
  },

  async reload() {
    await withDebugger(async (rdp) => {
      const { addons } = await rdp.request("root", "listAddons");
      const addon = addons.find((a) => a.id === EXT_ID);
      if (!addon) throw new Error("SelfControl is not installed — `start` it");
      await rdp.request(addon.actor, "reload");
    });
    console.log("reloaded");
  },

  async log() {
    await withDebugger(async (rdp) => {
      if ((await backgroundState(rdp)) !== "running") {
        console.log("(the event page is stopped: nothing to show until something wakes it)");
        return;
      }
      const { watcher } = await watch(rdp);
      rdp.on(printResources);
      // What the live pages logged so far arrives straight after subscribing,
      // sometimes trailing the reply by a moment.
      await rdp.request(watcher, "watchResources", CONSOLE);
      await sleep(1000);
    });
  },

  async follow(args) {
    const seconds = Number(args[0] ?? 0);
    const rdp = await connect();
    const { watcher } = await watch(rdp);
    rdp.on((p) => {
      if (p.type === "target-available-form") console.log(`${clockTime(Date.now())} -- ${p.target.url ?? "?"}`);
    });
    rdp.on(printResources);
    await rdp.request(watcher, "watchResources", CONSOLE);
    if (seconds > 0) setTimeout(() => process.exit(0), seconds * 1000);
    await new Promise(() => {});
  },

  async eval(args) {
    const pageAt = args.indexOf("--page");
    const page = pageAt >= 0 ? args[pageAt + 1] : null;
    const expr = args.find((_, i) => pageAt < 0 || (i !== pageAt && i !== pageAt + 1));
    if (!expr) throw new Error("evaluate what?");
    await withDebugger(async (rdp) => {
      if (!page) await wake(rdp);
      const { targets } = await watch(rdp);
      const pick = () => targets.find((t) => (page ? (t.url ?? "").includes(page) : isBackground(t)));
      await waitFor(() => Boolean(pick()), page ? `an open page matching "${page}"` : "the event page", 10_000);
      console.log(await evaluate(rdp, pick().consoleActor, expr));
    });
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
try {
  await commands[command](rest);
  if (command !== "follow") process.exit(0);
} catch (err) {
  console.error(`android ${command}: ${err.message}`);
  process.exit(1);
}
