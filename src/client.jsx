import React, { useState, useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import xtermCss from "xterm/css/xterm.css";

/**
 * dsh-terminal - client half v3 (source; bundled into lib/client.js).
 *
 * A floating terminal window in the shell.overlay layer:
 *   row 1: brand + terminal tabs (+ new)
 *   row 2: shell selector + "ask the agent" + collapse
 *   row 3: the terminal itself (one xterm per tab, only the active one laid out)
 * Hidden by default; the `>_` button in the composer opens it. The two header
 * rows drag the window and a bottom-right handle resizes it; geometry persists
 * in localStorage and is clamped to the overlay bounds.
 *
 * v3 rewrote the sizing story around ONE guarded fit path, because the old
 * code kept shrinking the terminal area:
 *   - FitAddon.fit() on a display:none container proposes 2 cols x 1 row, so
 *     every fit while a tab was hidden (mount-time fit, observer races) shrank
 *     that tab into a one-column sliver and forwarded resize(2,1) to the PTY.
 *   - Four independent fit triggers (mount fit, rAF-on-activate, a 1.5s
 *     self-heal interval, body ResizeObserver) fought each other and formed a
 *     resize storm.
 * Now there is exactly one fit entry point, tryFit(), with hard guards:
 *   - skip while the pane is hidden (zero-size container),
 *   - skip when the measured size did not actually change,
 *   - force once after mount/activation once real layout exists.
 * A per-pane ResizeObserver on the measured box is the only automatic trigger.
 *
 * v3.1 additionally:
 *   - holds PTY resize forwards while the corner handle is being dragged and
 *     delivers exactly one per terminal on release (per-frame forwards made
 *     ConPTY reflow the whole screen repeatedly, turning output into garbage);
 *   - binds copy/paste explicitly (Ctrl+C with a selection copies, Ctrl+Shift+C
 *     copies, Ctrl+V / Ctrl+Shift+V / Shift+Insert paste) plus toolbar
 *     copy/paste buttons, because xterm's built-in bindings do not fire here.
 */

const NS = "dsh-terminal";
const inject = ["slots", "locale", "remote", "sessions"];

const CSS_ID = "dsh-terminal/terminal.css";

const zh = {
  nav: "终端",
  newTerminal: "新建终端",
  closeTerminal: "关闭终端",
  notifyAgent: "提请智能体注意",
  notified: "已提请智能体注意 ✓",
  shell: "终端类型",
  empty: "还没有终端，点击「+」新建一个。",
  noSession: "打开一个会话后即可使用终端。",
  collapse: "收起",
  creating: "正在创建…",
  unavailable: "不可用",
  resize: "调整大小",
  copy: "复制",
  paste: "粘贴",
  interrupt: "中断",
  interruptHint: "发送 Ctrl+C 中断正在运行的命令",
  disconnected: "终端服务连接已断开（网关可能已重启），请刷新页面后重新打开终端。",
  writeFailed: "输入未能送达终端——该终端可能已失效（例如网关重启过）。请刷新页面后重新打开终端。",
};

const en = {
  nav: "Terminal",
  newTerminal: "New terminal",
  closeTerminal: "Close terminal",
  notifyAgent: "Ask the agent to look",
  notified: "Agent notified ✓",
  shell: "Shell",
  empty: "No terminals yet — click “+” to create one.",
  noSession: "Open a session to use the terminal.",
  collapse: "Collapse",
  creating: "Creating…",
  unavailable: "unavailable",
  resize: "Resize",
  copy: "Copy",
  paste: "Paste",
  interrupt: "Interrupt",
  interruptHint: "Send Ctrl+C to interrupt the running command",
  disconnected: "Terminal service disconnected (the gateway may have restarted) — refresh the page and reopen the terminal.",
  writeFailed: "Input did not reach the terminal — it may no longer exist (e.g. the gateway restarted). Refresh the page and reopen the terminal.",
};

const CUSTOM_CSS = `
.dtw-root{position:absolute;z-index:40;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#1c1e22);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 12px 32px rgba(0,0,0,.35));pointer-events:auto;min-width:340px;min-height:220px}
.dtw-header{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;flex:none}
.dtw-header:active{cursor:grabbing}
.dtw-brand{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:20px;flex:none;font-family:ui-monospace,Consolas,"Courier New",monospace}
.dtw-brand::before{content:">_";color:var(--dsw-alias-state-business-primary)}
.dtw-tabs{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}
.dtw-tabs::-webkit-scrollbar{display:none}
.dtw-tab{display:inline-flex;align-items:center;gap:6px;padding:2px 6px 2px 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;flex:none}
.dtw-tab:hover{border-color:var(--dsw-alias-border-l2)}
.dtw-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dtw-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;display:inline-block}
.dtw-tab[data-exited="true"] .dtw-tab-dot{background:var(--dsw-alias-state-error-primary)}
.dtw-tab-close{color:var(--dsw-alias-label-tertiary);border-radius:4px;width:16px;height:16px;line-height:14px;text-align:center;font-size:13px}
.dtw-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dtw-toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;flex:none;flex-wrap:wrap;row-gap:4px}
.dtw-toolbar:active{cursor:grabbing}
.dtw-btn{font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 9px;flex:none}
.dtw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dtw-btn:disabled{cursor:default;opacity:.55}
.dtw-select{font:inherit;font-size:12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px}
.dtw-spacer{flex:1 1 auto}
.dtw-status{padding:6px 12px 0;font-size:12px;flex:none}
.dtw-status-ok{color:var(--dsw-alias-state-success-primary)}
.dtw-status-err{color:var(--dsw-alias-state-error-primary)}
.dtw-body{flex:1 1 auto;min-height:120px;position:relative}
.dtw-pane{position:absolute;inset:0;padding:8px 6px 6px 10px;box-sizing:border-box}
.dtw-pane[data-active="false"]{display:none}
.dtw-measure{width:100%;height:100%;min-width:0;min-height:0}
.dtw-xterm{width:100%;height:100%}
.dtw-xterm .xterm{height:100%}
.dtw-xterm .xterm .xterm-viewport{scrollbar-width:none;-ms-overflow-style:none}
.dtw-xterm .xterm .xterm-viewport::-webkit-scrollbar{display:none;width:0;height:0}
.dtw-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:22px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;box-sizing:border-box}
.dtw-resize{position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none;z-index:3;background:transparent;border:none;padding:0}
.dtw-resize::after{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;border-right:2px solid var(--dsw-alias-label-tertiary);border-bottom:2px solid var(--dsw-alias-label-tertiary);opacity:.75}
.dtw-toggle{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;height:28px;padding:0 10px;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center}
.dtw-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dtw-toggle[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-state-business-primary)}
`;

// ── module state (lives for the plugin lifetime; UI subscribes) ─────────────

let windowOpen = false; // hidden by default; the `>_` button opens it
let shellChoice = "powershell";
let shellsCache = [];
let localeT = (key) => key;
let rpc = null;
let sessionsInfo = null;

const versionListeners = new Set();
function bump() {
  for (const listener of [...versionListeners]) listener();
}
function subscribeVersion(listener) {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}
function useVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeVersion(() => setVersion((value) => value + 1)), []);
  return version;
}

function currentSessionId() {
  try {
    return sessionsInfo?.getSnapshot().sessionId;
  } catch {
    return undefined;
  }
}

const liveTerms = new Set(); // live xterm instances, for the theme observer
let writeFailed = false; // a write RPC failed → the pane targets a dead terminal

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value.length > 0) return value;
  } catch {
    // fall through
  }
  return fallback;
}

function themeFromDom() {
  const background = cssVar("--dsw-alias-bg-layer-1", "#1c1e22");
  const foreground = cssVar("--dsw-alias-label-primary", "#e8eaed");
  const dim = cssVar("--dsw-alias-label-tertiary", "#8a9099");
  const accent = cssVar("--dsw-alias-state-business-primary", "#4d6bfe");
  const red = cssVar("--dsw-alias-state-error-primary", "#e5484d");
  const green = cssVar("--dsw-alias-state-success-primary", "#30a46c");
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: "rgba(77,107,254,0.30)",
    black: background,
    red,
    green,
    yellow: "#d7ba7d",
    blue: accent,
    magenta: "#c586c0",
    cyan: "#4ec9b0",
    white: foreground,
    brightBlack: dim,
    brightRed: red,
    brightGreen: green,
    brightYellow: "#e5c07b",
    brightBlue: accent,
    brightMagenta: "#c586c0",
    brightCyan: "#4ec9b0",
    brightWhite: foreground,
  };
}

function installThemeObserver() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  let scheduled = false;
  const applyTheme = () => {
    scheduled = false;
    const theme = themeFromDom();
    for (const term of liveTerms) {
      try {
        term.options.theme = theme;
      } catch {
        // terminal already disposed
      }
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(applyTheme);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  return () => observer.disconnect();
}

function cssTag() {
  if (typeof document === "undefined") return null;
  let tag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
  if (tag === null) {
    tag = document.createElement("style");
    tag.dataset.plugin = "dsh-terminal";
    tag.dataset.pluginCss = CSS_ID;
    document.head.appendChild(tag);
  }
  return tag;
}

// ── window geometry (persisted; min/max enforced while dragging/resizing) ────

const WIN_STORAGE_KEY = "dsh-terminal/window.v5";
const WIN_MIN_W = 340;
const WIN_MIN_H = 220;
const WIN_MAX_W = 1100; // hard max size (≈1.5× default)
const WIN_MAX_H = 640;
const EDGE = 4; // keep this many px inside the overlay bounds

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function defaultWindowState() {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(760, Math.max(WIN_MIN_W, vw - 240));
  const h = 420;
  return { x: Math.max(16, vw - w - 24), y: Math.max(16, vh - h - 160), w, h };
}

function loadWindowState() {
  try {
    if (typeof localStorage === "undefined") return defaultWindowState();
    const raw = localStorage.getItem(WIN_STORAGE_KEY);
    if (raw == null) return defaultWindowState();
    const value = JSON.parse(raw);
    if (
      typeof value?.x === "number" && Number.isFinite(value.x) &&
      typeof value?.y === "number" && Number.isFinite(value.y) &&
      typeof value?.w === "number" && Number.isFinite(value.w) &&
      typeof value?.h === "number" && Number.isFinite(value.h)
    ) {
      return {
        x: value.x,
        y: value.y,
        w: clamp(value.w, WIN_MIN_W, WIN_MAX_W),
        h: clamp(value.h, WIN_MIN_H, WIN_MAX_H),
      };
    }
    return defaultWindowState();
  } catch {
    return defaultWindowState();
  }
}

function saveWindowState(state) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(WIN_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode or quota: geometry just won't persist
  }
}

// The overlay layer is the stable anchor: the layout package renders it as an
// absolutely positioned layer covering the whole app frame (data-shell-overlay).
// All window coordinates are relative to it, so measuring ITS rect keeps every
// clamp consistent regardless of any wrapper the slots runtime may add.
function overlayBounds(root) {
  try {
    const overlay = root?.closest?.('[data-shell-overlay]') ?? null;
    if (overlay != null && typeof overlay.getBoundingClientRect === "function") {
      const rect = overlay.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { w: rect.width, h: rect.height };
    }
  } catch {
    // fall through
  }
  return {
    w: typeof window !== "undefined" ? window.innerWidth : 1200,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  };
}

// ── wire contribution (mirrors the host MANIFEST; identity codecs) ──────────

const identity = (value) => value;
const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });
const wireParam = (name, wire) => ({ name, wire, source: "json", codec: codec("dsh-terminal#" + wire) });
const wireParams = (...names) => names.map((wire) => wireParam(wire, wire));

const CONTRIBUTION = {
  package: "dsh-terminal",
  descriptors: [
    {
      id: "dsh-terminal#terminalService/create",
      service: "terminalService",
      namespace: "terminalService",
      method: "create",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "shell", "cols", "rows"),
      result: codec("dsh-terminal#CreateResult"),
    },
    {
      id: "dsh-terminal#terminalService/write",
      service: "terminalService",
      namespace: "terminalService",
      method: "write",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "id", "data"),
      result: codec("dsh-terminal#OkResult"),
    },
    {
      id: "dsh-terminal#terminalService/resize",
      service: "terminalService",
      namespace: "terminalService",
      method: "resize",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "id", "cols", "rows"),
      result: codec("dsh-terminal#OkResult"),
    },
    {
      id: "dsh-terminal#terminalService/read",
      service: "terminalService",
      namespace: "terminalService",
      method: "read",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "id", "after"),
      result: codec("dsh-terminal#ReadResult"),
    },
    {
      id: "dsh-terminal#terminalService/kill",
      service: "terminalService",
      namespace: "terminalService",
      method: "kill",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "id"),
      result: codec("dsh-terminal#OkResult"),
    },
    {
      id: "dsh-terminal#terminalService/list",
      service: "terminalService",
      namespace: "terminalService",
      method: "list",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId"),
      result: codec("dsh-terminal#ListResult"),
    },
    {
      id: "dsh-terminal#terminalService/notify",
      service: "terminalService",
      namespace: "terminalService",
      method: "notify",
      invocation: { kind: "direct" },
      parameters: wireParams("sessionId", "id"),
      result: codec("dsh-terminal#OkResult"),
    },
    {
      id: "dsh-terminal#terminalService/shells",
      service: "terminalService",
      namespace: "terminalService",
      method: "shells",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-terminal#ShellsResult"),
    },
  ],
};

function cleanHostError(error) {
  return String(error?.message ?? error).replace(/^terminalService\.[a-zA-Z]+ failed: [a-z-]+: /, "");
}

// ── PTY resize forwarding: collapse bursts, hold during corner drags ────────
// Every forwarded resize makes ConPTY reflow the whole screen. While the user
// drags the corner handle the terminal re-fits every frame, so forwarding each
// frame floods the PTY with resize events and rewraps the scrollback into
// garbage (repeated banner lines, interleaved columns). We therefore HOLD all
// forwards while a resize gesture is active and deliver exactly one per
// terminal when it ends; outside gestures, bursts collapse into a short
// trailing throttle.

const resizeQueue = new Map(); // terminalId -> { sessionId, cols, rows }
const resizeTimers = new Map(); // terminalId -> timeout id
let resizeGesture = false;

function deliverResize(id) {
  resizeTimers.delete(id);
  const entry = resizeQueue.get(id);
  if (entry === undefined) return;
  resizeQueue.delete(id);
  if (rpc !== null) rpc.call("resize", entry.sessionId, id, entry.cols, entry.rows).catch(() => {});
}

function recordResize(sessionId, id, cols, rows) {
  if (resizeTimers.has(id)) {
    clearTimeout(resizeTimers.get(id));
    resizeTimers.delete(id);
  }
  resizeQueue.set(id, { sessionId, cols, rows });
  if (!resizeGesture) {
    resizeTimers.set(id, setTimeout(() => deliverResize(id), 120));
  }
}

function dropResize(id) {
  if (resizeTimers.has(id)) {
    clearTimeout(resizeTimers.get(id));
    resizeTimers.delete(id);
  }
  resizeQueue.delete(id);
}

function setResizeGesture(active) {
  resizeGesture = active;
  if (!active) {
    for (const timer of resizeTimers.values()) clearTimeout(timer);
    resizeTimers.clear();
    for (const id of [...resizeQueue.keys()]) deliverResize(id);
  }
}

// ── clipboard helpers ────────────────────────────────────────────────────────
// xterm's built-in copy/paste key handling does not fire reliably inside the
// DSH shell (plain Ctrl+V reached the PTY as ^V), so the pane binds these
// explicitly. The toolbar buttons call the same helpers.

let clipboardTerm = null; // last focused/active live terminal

function legacyCopy(text) {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  } catch {
    // clipboard unavailable
  }
}

function copyText(text) {
  if (typeof text !== "string" || text.length === 0) return;
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      return;
    }
  } catch {
    // fall through
  }
  legacyCopy(text);
}

function pasteText(term) {
  try {
    if (navigator.clipboard?.readText !== undefined) {
      navigator.clipboard.readText().then((text) => {
        if (typeof text !== "string" || text.length === 0) return;
        try {
          term.paste(text);
        } catch {
          // terminal disposed in the meantime
        }
      }).catch(() => {});
    }
  } catch {
    // clipboard API unavailable: nothing to paste programmatically
  }
}

function sendInterrupt(term) {
  try {
    term.paste("\u0003"); // Ctrl+C → ETX → ConPTY interrupts the running command
  } catch {
    // terminal disposed in the meantime
  }
}

// ── components ───────────────────────────────────────────────────────────────

function ToggleButton(props) {
  useVersion();
  if (props.sessionId == null) return null;
  return (
    <button
      type="button"
      className="dtw-toggle"
      aria-pressed={windowOpen}
      title={localeT("nav")}
      onClick={() => {
        windowOpen = !windowOpen;
        bump();
      }}
    >
      &gt;_
    </button>
  );
}

/**
 * One xterm instance per terminal tab. Layout:
 *   .dtw-pane (absolute inset:0, padding) > .dtw-measure (exact content box)
 *   > .dtw-xterm (fills the measure box; term.open() target)
 * FitAddon measures the terminal element's parent (.dtw-measure), which has no
 * padding/border, so proposed cols/rows match the visible box exactly.
 */
function TerminalPane({ sessionId, item, active }) {
  const measureRef = useRef(null);
  const xtermRef = useRef(null);
  const termRef = useRef(null);
  const tryFitRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const exitedRef = useRef(false);
  const cursorRef = useRef(0);
  const lastSizeRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    const measure = measureRef.current;
    const host = xtermRef.current;
    if (measure == null || host == null) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, "Courier New", monospace',
      scrollback: 5000,
      theme: themeFromDom(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    liveTerms.add(term);

    // Copy/paste: bind explicitly because xterm's built-in handling does not
    // fire reliably here (Ctrl+V used to reach the PTY as ^V). Handled keys
    // preventDefault so the browser's own default action (in particular the
    // native paste into the hidden textarea, which would paste a second time)
    // never runs; paste also ignores key repeats.
    const keyHandler = (event) => {
      if (event.type !== "keydown") return true;
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
      const shift = event.shiftKey;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      // select all: Ctrl+A (VS Code-style; keeps ^A from reaching the shell)
      if (mod && key === "a") {
        event.preventDefault();
        term.selectAll();
        return false;
      }
      // copy: Ctrl+Shift+C always; Ctrl+C only while there is a selection
      // (without a selection Ctrl+C must keep aborting the running command).
      // The selection is cleared right after copying so a lingering selection
      // can never swallow the NEXT Ctrl+C meant to interrupt a task.
      if (mod && key === "c" && (shift || term.hasSelection())) {
        event.preventDefault();
        copyText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (mod && key === "insert") {
        event.preventDefault();
        copyText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // paste: Ctrl+V / Ctrl+Shift+V / Shift+Insert
      if ((mod && key === "v") || (shift && key === "insert")) {
        event.preventDefault();
        if (!event.repeat) pasteText(term);
        return false;
      }
      return true;
    };
    term.attachCustomKeyEventHandler(keyHandler);

    // xterm also listens for the browser 'paste' event on its hidden
    // textarea; block it in the capture phase (before xterm's listener) so a
    // paste reaches the terminal only through our explicit key bindings.
    const pasteBlocker = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    measure.addEventListener("paste", pasteBlocker, true);

    // Track the last focused/active terminal for the toolbar copy/paste buttons.
    if (clipboardTerm === null) clipboardTerm = term;
    const textarea = term.textarea;
    const onFocus = () => {
      clipboardTerm = term;
    };
    if (textarea != null) textarea.addEventListener("focus", onFocus);

    // The ONE fit entry point. Guards (in order):
    //  1. never fit while this tab is hidden — a zero-sized container would
    //     make FitAddon propose 2 cols x 1 row and shrink the PTY,
    //  2. never fit when the measured size hasn't really changed,
    //  3. force=true (mount/activation) bypasses the size check but still
    //     requires a measurable container.
    const tryFit = (force = false) => {
      if (!force && !activeRef.current) return;
      const w = measure.clientWidth;
      const h = measure.clientHeight;
      if (w <= 0 || h <= 0) return; // hidden or not laid out yet
      const last = lastSizeRef.current;
      if (!force && Math.abs(w - last.w) <= 1 && Math.abs(h - last.h) <= 1) return;
      try {
        fit.fit();
        lastSizeRef.current = { w: measure.clientWidth, h: measure.clientHeight };
      } catch {
        // transient measurement failure: the next real size change retries
      }
    };
    tryFitRef.current = tryFit;

    // keystrokes → host, batched
    let pending = "";
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      const chunk = pending;
      pending = "";
      if (chunk.length > 0 && rpc !== null) {
        rpc.call("write", sessionId, item.id, chunk).then(() => {
          if (writeFailed) {
            writeFailed = false;
            bump();
          }
        }).catch(() => {
          // The terminal no longer exists on the host (ghost tab): surface it
          // instead of silently dropping the user's keystrokes.
          if (!writeFailed) {
            writeFailed = true;
            bump();
          }
        });
      }
    };
    const dataDisposable = term.onData((data) => {
      pending += data;
      if (flushTimer === null) flushTimer = setTimeout(flush, 40);
    });

    // real col/row changes → host, through the burst-collapsing forwarder
    // (held entirely while a corner-drag gesture is in progress)
    let lastCols = -1;
    let lastRows = -1;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      recordResize(sessionId, item.id, cols, rows);
    });

    // output poll: read incremental output and write it into the terminal
    const poll = setInterval(() => {
      if (rpc === null) return;
      rpc.call("read", sessionId, item.id, cursorRef.current).then((result) => {
        if (result == null) return;
        const offset = typeof result.offset === "number" ? result.offset : cursorRef.current;
        if (offset < cursorRef.current) {
          // The host buffer rewound — the gateway restarted and this id now
          // belongs to a fresh, empty terminal. The local xterm still shows
          // the pre-restart screen: reset it and re-sync from the start on
          // the next tick instead of mixing stale pixels with new output.
          term.reset();
          cursorRef.current = 0;
          exitedRef.current = false;
          return;
        }
        cursorRef.current = offset;
        if (typeof result.text === "string" && result.text.length > 0) term.write(result.text);
        if (result.exit != null && !exitedRef.current) {
          exitedRef.current = true;
          bump();
        }
      }).catch(() => {});
    }, 150);

    // initial fit, once layout has actually settled (double rAF)
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => tryFit(true));
    });

    // only automatic trigger: the measured box changed size
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => tryFit(false));
      observer.observe(measure);
    }

    return () => {
      clearInterval(poll);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (observer !== null) observer.disconnect();
      if (flushTimer !== null) clearTimeout(flushTimer);
      measure.removeEventListener("paste", pasteBlocker, true);
      if (textarea != null) textarea.removeEventListener("focus", onFocus);
      if (clipboardTerm === term) clipboardTerm = null;
      dropResize(item.id);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      liveTerms.delete(term);
      termRef.current = null;
      tryFitRef.current = null;
      try {
        term.dispose();
      } catch {
        // already disposed
      }
    };
  }, [sessionId, item.id]);

  // tab became active: refit now that it is visible (double rAF so the
  // display:none → block flip has painted; guarded tryFit dedupes size)
  useEffect(() => {
    if (!active) return undefined;
    if (termRef.current !== null) clipboardTerm = termRef.current;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => tryFitRef.current?.(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [active]);

  return (
    <div className="dtw-pane" data-active={active ? "true" : "false"}>
      <div ref={measureRef} className="dtw-measure">
        <div ref={xtermRef} className="dtw-xterm" />
      </div>
    </div>
  );
}

function TerminalWindow() {
  useVersion();
  const open = windowOpen;
  const [sessionId, setSessionId] = useState(() => currentSessionId());
  const [terms, setTerms] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState(null);
  const [notified, setNotified] = useState(null);
  const [creating, setCreating] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [win, setWin] = useState(() => loadWindowState());
  const winRef = useRef(win);
  winRef.current = win;
  const termsRef = useRef(terms);
  termsRef.current = terms;
  const rootRef = useRef(null);
  const notifiedTimer = useRef(null);
  // Terminals the user closed via × : the host keeps a killed handle readable
  // for a few seconds, so list results are filtered by these ids to prevent
  // the closed tab from flashing back before its removal settles.
  const closedIdsRef = useRef(new Set());
  const lastSessionRef = useRef(sessionId);
  const listFailRef = useRef(0); // consecutive list failures → ghost-tab detection

  // Track the current session id with a light poll (the list refresh below
  // follows it; avoids any snapshot-subscription edge cases). Only while open.
  useEffect(() => {
    if (!open) return undefined;
    const sync = () => {
      const id = currentSessionId();
      setSessionId((previous) => (previous === id ? previous : id));
    };
    sync();
    const interval = setInterval(sync, 1000);
    return () => clearInterval(interval);
  }, [open]);

  // Terminal list refresh; only while open. User-closed ids are filtered out
  // locally (see closedIdsRef) and pruned once the host finally drops them.
  useEffect(() => {
    if (!open || sessionId == null || rpc === null) {
      setTerms([]);
      setActiveId(null);
      return undefined;
    }
    if (lastSessionRef.current !== sessionId) {
      lastSessionRef.current = sessionId;
      closedIdsRef.current.clear();
    }
    let current = true;
    const refresh = () => {
      rpc.call("list", sessionId).then((snapshot) => {
        if (!current) return;
        listFailRef.current = 0;
        setDisconnected(false);
        writeFailed = false;
        const raw = snapshot != null && Array.isArray(snapshot.terminals) ? snapshot.terminals : [];
        const list = raw.filter((item) => !closedIdsRef.current.has(item.id));
        if (closedIdsRef.current.size > 0) {
          const present = new Set(raw.map((item) => item.id));
          for (const id of [...closedIdsRef.current]) {
            if (!present.has(id)) closedIdsRef.current.delete(id);
          }
        }
        setTerms(list);
        setActiveId((previous) => (previous != null && list.some((item) => item.id === previous) ? previous : list[0]?.id ?? null));
      }).catch(() => {
        if (!current) return;
        // After a gateway restart the RPCs keep failing forever; keeping the
        // previous list would leave ghost tabs showing stale content while
        // the host has nothing. Treat ≥3 consecutive failures as a real
        // disconnect: drop the ghosts and surface it. A later success
        // repopulates everything automatically.
        listFailRef.current += 1;
        if (listFailRef.current >= 3) {
          setDisconnected(true);
          setTerms([]);
          setActiveId(null);
        }
      });
    };
    refresh();
    const interval = setInterval(refresh, 2500);
    return () => {
      current = false;
      clearInterval(interval);
    };
  }, [open, sessionId]);

  // When the browser window resizes, the overlay bounds change: re-clamp the
  // window position so it can never end up stuck off-screen. Size is untouched
  // (never shrinks on its own).
  useEffect(() => {
    if (!open) return undefined;
    const clampToBounds = () => {
      const bounds = overlayBounds(rootRef.current);
      setWin((previous) => {
        const x = clamp(previous.x, EDGE, Math.max(EDGE, bounds.w - previous.w - EDGE));
        const y = clamp(previous.y, EDGE, Math.max(EDGE, bounds.h - previous.h - EDGE));
        if (x === previous.x && y === previous.y) return previous;
        const next = { ...previous, x, y };
        saveWindowState(next);
        return next;
      });
    };
    window.addEventListener("resize", clampToBounds);
    return () => window.removeEventListener("resize", clampToBounds);
  }, [open]);

  // Clear the "notified" toast timer on unmount.
  useEffect(() => () => {
    if (notifiedTimer.current !== null) clearTimeout(notifiedTimer.current);
  }, []);

  // Safety: never leave a resize gesture armed if the window unmounts
  // mid-drag (the queued final resize would otherwise never flush).
  useEffect(() => () => setResizeGesture(false), []);

  const handleCreate = () => {
    if (sessionId == null || rpc === null || creating) return;
    setCreating(true);
    setError(null);
    rpc.call("create", sessionId, shellChoice, 100, 28).then((created) => {
      setTerms((previous) => [...(previous ?? []), created]);
      setActiveId(created.id);
      setCreating(false);
    }).catch((failure) => {
      setError(cleanHostError(failure));
      setCreating(false);
    });
  };

  const handleClose = (id) => {
    if (rpc !== null) rpc.call("kill", sessionId, id).catch(() => {});
    closedIdsRef.current.add(id);
    setTerms((previous) => (previous ?? []).filter((item) => item.id !== id));
    setActiveId((previous) => {
      if (previous !== id) return previous;
      const rest = (termsRef.current ?? []).filter((item) => item.id !== id);
      return rest[0]?.id ?? null;
    });
  };

  const handleNotify = () => {
    if (sessionId == null || rpc === null) return;
    const target = activeId ?? "";
    rpc.call("notify", sessionId, target).then(() => {
      setNotified(target);
      if (notifiedTimer.current !== null) clearTimeout(notifiedTimer.current);
      notifiedTimer.current = setTimeout(() => setNotified(null), 2500);
    }).catch((failure) => setError(cleanHostError(failure)));
  };

  const handleCopy = () => {
    if (clipboardTerm == null) return;
    try {
      copyText(clipboardTerm.getSelection());
    } catch {
      // terminal disposed in the meantime
    }
  };

  const handlePaste = () => {
    if (clipboardTerm == null) return;
    try {
      pasteText(clipboardTerm);
    } catch {
      // terminal disposed in the meantime
    }
  };

  const handleInterrupt = () => {
    if (clipboardTerm == null) return;
    try {
      sendInterrupt(clipboardTerm);
    } catch {
      // terminal disposed in the meantime
    }
  };

  // ── drag: document-level listeners, all math overlay-relative ─────────────
  const startDrag = (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, select, input, a")) return;
    const bounds = overlayBounds(rootRef.current);
    const state = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: winRef.current.x,
      y: winRef.current.y,
      bounds,
    };
    event.preventDefault();
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return;
      const maxX = Math.max(EDGE, state.bounds.w - winRef.current.w - EDGE);
      const maxY = Math.max(EDGE, state.bounds.h - winRef.current.h - EDGE);
      setWin((previous) => ({
        ...previous,
        x: clamp(state.x + moveEvent.clientX - state.startX, EDGE, maxX),
        y: clamp(state.y + moveEvent.clientY - state.startY, EDGE, maxY),
      }));
    };
    const finish = () => {
      clearTimeout(safetyTimer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      saveWindowState(winRef.current);
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId === state.pointerId) finish();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    // Safety: never leak a gesture. If nothing settles within 3s, cancel it.
    const safetyTimer = setTimeout(finish, 3000);
  };

  // ── resize: document-level listeners with hard min/max limits ─────────────
  const startResize = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setResizeGesture(true); // hold PTY resize forwards until the drag ends
    const bounds = overlayBounds(rootRef.current);
    const state = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      w: winRef.current.w,
      h: winRef.current.h,
      bounds,
    };
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return;
      const maxW = clamp(state.bounds.w - 2 * EDGE, WIN_MIN_W, WIN_MAX_W);
      const maxH = clamp(state.bounds.h - 2 * EDGE, WIN_MIN_H, WIN_MAX_H);
      setWin((previous) => ({
        ...previous,
        w: clamp(state.w + moveEvent.clientX - state.startX, WIN_MIN_W, maxW),
        h: clamp(state.h + moveEvent.clientY - state.startY, WIN_MIN_H, maxH),
      }));
    };
    const finish = () => {
      clearTimeout(safetyTimer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      setResizeGesture(false); // flush one final resize per terminal
      saveWindowState(winRef.current);
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId === state.pointerId) finish();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    // Safety: never leak a gesture. If nothing settles within 3s, cancel it.
    const safetyTimer = setTimeout(finish, 3000);
  };

  const shells = shellsCache.length > 0 ? shellsCache : [{ kind: "powershell", label: "PowerShell", available: true }];
  const list = terms ?? [];

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="dtw-root"
      style={{ left: win.x, top: win.y, width: Math.max(WIN_MIN_W, win.w), height: Math.max(WIN_MIN_H, win.h) }}
      data-dsh-terminal="window"
      onKeyDown={(event) => {
        // Route Ctrl+C pressed outside the terminal area (header, toolbar,
        // empty region) to the active terminal, so a running task can be
        // interrupted even when the xterm textarea is not focused. Inside
        // the terminal area xterm handles it (copy with selection, ETX
        // without).
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && typeof event.key === "string" && event.key.toLowerCase() === "c") {
          const target = event.target;
          if (target instanceof Element && target.closest(".dtw-measure") != null) return;
          event.preventDefault();
          if (clipboardTerm != null) {
            try {
              sendInterrupt(clipboardTerm);
            } catch {
              // terminal disposed in the meantime
            }
          }
        }
      }}
    >
      <div className="dtw-header" onPointerDown={startDrag}>
        <span className="dtw-brand">{localeT("nav")}</span>
        <div className="dtw-tabs" role="tablist">
          {list.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="dtw-tab"
              data-active={item.id === activeId ? "true" : "false"}
              data-exited={item.exited ? "true" : "false"}
              aria-selected={item.id === activeId}
              title={item.shell + " · " + item.cwd}
              onClick={() => setActiveId(item.id)}
            >
              <span className="dtw-tab-dot" aria-hidden="true" />
              <span>{item.name}</span>
              <span
                className="dtw-tab-close"
                role="button"
                aria-label={localeT("closeTerminal")}
                title={localeT("closeTerminal")}
                onClick={(event) => {
                  event.stopPropagation();
                  handleClose(item.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
          <button
            type="button"
            className="dtw-btn"
            onClick={handleCreate}
            disabled={creating || sessionId == null}
            title={localeT("newTerminal")}
            aria-label={localeT("newTerminal")}
          >
            {creating ? localeT("creating") : "+"}
          </button>
        </div>
      </div>
      <div className="dtw-toolbar" onPointerDown={startDrag}>
        <select
          className="dtw-select"
          value={shellChoice}
          aria-label={localeT("shell")}
          onChange={(event) => {
            shellChoice = event.currentTarget.value;
            bump();
          }}
        >
          {shells.map((shell) => (
            <option key={shell.kind} value={shell.kind} disabled={!shell.available}>
              {shell.label}
              {shell.available ? "" : "（" + localeT("unavailable") + "）"}
            </option>
          ))}
        </select>
        <button type="button" className="dtw-btn" onClick={handleNotify} disabled={activeId == null}>
          {localeT("notifyAgent")}
        </button>
        <button type="button" className="dtw-btn" onClick={handleCopy} disabled={clipboardTerm == null} title={localeT("copy")}>
          {localeT("copy")}
        </button>
        <button type="button" className="dtw-btn" onClick={handlePaste} disabled={clipboardTerm == null} title={localeT("paste")}>
          {localeT("paste")}
        </button>
        <button type="button" className="dtw-btn" onClick={handleInterrupt} disabled={clipboardTerm == null} title={localeT("interruptHint")}>
          {localeT("interrupt")}
        </button>
        <span className="dtw-spacer" />
        <button
          type="button"
          className="dtw-btn"
          title={localeT("collapse")}
          aria-label={localeT("collapse")}
          onClick={() => {
            windowOpen = false;
            bump();
          }}
        >
          ▾
        </button>
      </div>
      {notified != null && notified === activeId ? <div className="dtw-status dtw-status-ok">{localeT("notified")}</div> : null}
      {disconnected ? <div className="dtw-status dtw-status-err" role="alert">{localeT("disconnected")}</div> : null}
      {writeFailed ? <div className="dtw-status dtw-status-err" role="alert">{localeT("writeFailed")}</div> : null}
      {error != null ? <div className="dtw-status dtw-status-err" role="alert">{error}</div> : null}
      <div className="dtw-body">
        {list.map((item) => (
          <TerminalPane key={item.id} sessionId={sessionId} item={item} active={item.id === activeId} />
        ))}
        {list.length === 0
          ? <div className="dtw-empty">{sessionId == null ? localeT("noSession") : localeT("empty")}</div>
          : null}
      </div>
      <button
        type="button"
        className="dtw-resize"
        aria-label={localeT("resize")}
        onPointerDown={startResize}
      />
    </div>
  );
}

// ── cordis plugin body ───────────────────────────────────────────────────────

function apply(ctx) {
  const tag = cssTag();
  if (tag !== null) tag.textContent = CUSTOM_CSS + "\n" + xtermCss;
  ctx.effect(() => () => {
    if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
  }, "dsh-terminal: css");

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-terminal: dictionaries");
  localeT = ctx.locale.bind(NS);

  try {
    sessionsInfo = ctx.get("sessions")?.currentProvideInfo ?? null;
  } catch {
    sessionsInfo = null;
  }

  const mount = ctx.remote.$mount(CONTRIBUTION);
  rpc = {
    call: async (method, ...args) => {
      await mount;
      const remote = ctx.get("remote.terminalService");
      const result = await remote[method](...args);
      if (!result.ok) throw new Error("terminalService." + method + " failed: " + result.error.code + ": " + result.error.message);
      return result.value;
    },
  };

  const stopThemeObserver = installThemeObserver();
  ctx.effect(() => stopThemeObserver, "dsh-terminal: theme observer");

  rpc.call("shells").then((snapshot) => {
    shellsCache = Array.isArray(snapshot?.shells) ? snapshot.shells : [];
    const current = shellsCache.find((shell) => shell.kind === shellChoice);
    if (current === undefined || !current.available) {
      const first = shellsCache.find((shell) => shell.available);
      if (first !== undefined) shellChoice = first.kind;
    }
    bump();
  }).catch(() => {});

  ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
    { name: "conversation.input.right", id: "dsh-terminal-toggle", order: 90, label: () => localeT("nav") },
    ToggleButton,
  ));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register(
    { name: "shell.overlay", id: "dsh-terminal-window", order: 90, label: () => localeT("nav") },
    TerminalWindow,
  ));
}

export { apply, inject };
