/**
 * dsh-terminal - host half.
 *
 * Owns one node-pty process per interactive terminal, keyed by session id.
 * The client UI drives terminals through a Typert Remote service
 * ("terminalService"). There is NO automatic output injection: the owning
 * agent receives nothing while the user types, and instead pulls content on
 * demand through two read-only model tools (terminal_list / terminal_read,
 * the latter with offset pagination). Two lifecycle messages remain:
 * - 终端退出: one status message (wakes the agent only on a non-zero exit
 *   that the user did not trigger),
 * - 用户请求你关注: sent when the user clicks the notify button (wakes the
 *   agent, which is then expected to call terminal_read itself).
 *
 * terminal_read output is reconstructed through a mini VT state machine
 * (screen-row model): ConPTY repaints the screen with cursor-movement
 * sequences, and replaying the stream collapses input-echo ghosts, reflow
 * repaints and duplicated content into clean screen content.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import pty from "@lydell/node-pty";

export const name = "dsh-terminal";
export const inject = ["typert", "sessions", "agents", "tools"];

// ── tuning ──────────────────────────────────────────────────────────────────

const RING_MAX = 2 * 1024 * 1024; // retained raw output bytes per terminal
const KILL_GRACE_MS = 3000; // keep an exited handle readable for this long
const TOOL_TAIL_DEFAULT = 8000; // terminal_read default tail size
const TOOL_TAIL_MAX = 30000;

// ── shell resolution ────────────────────────────────────────────────────────

const SHELLS = {
  powershell: {
    label: "PowerShell",
    candidates: ["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
    args: ["-NoLogo", "-NoProfile"],
  },
  pwsh: {
    label: "PowerShell 7 (pwsh)",
    candidates: ["pwsh.exe", "pwsh"],
    args: ["-NoLogo", "-NoProfile"],
  },
  cmd: {
    label: "Command Prompt (cmd)",
    candidates: [process.env.COMSPEC ?? "cmd.exe"],
    args: [],
  },
};

function findOnPath(names) {
  const dirs = (process.env.PATH ?? "").split(";").filter((part) => part.length > 0);
  for (const dir of dirs) {
    for (const base of names) {
      const candidate = join(dir, base);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // unreadable directory entry: keep scanning
      }
    }
  }
  return undefined;
}

function resolveShell(kind) {
  const spec = SHELLS[kind];
  if (spec === undefined) throw new Error(`未知终端类型 "${kind}"（可用: ${Object.keys(SHELLS).join(", ")}）`);
  for (const candidate of spec.candidates) {
    const found = isAbsolute(candidate) ? (existsSync(candidate) ? candidate : undefined) : findOnPath([candidate]);
    if (found !== undefined) return { file: found, args: spec.args };
  }
  const short = spec.candidates.find((candidate) => !isAbsolute(candidate));
  if (short !== undefined) return { file: short, args: spec.args };
  throw new Error(`找不到 ${spec.label} 的可执行文件`);
}

function listShells() {
  return Object.entries(SHELLS).map(([kind, spec]) => {
    let available = false;
    try {
      resolveShell(kind);
      available = true;
    } catch {
      available = false;
    }
    return { kind, label: spec.label, available };
  });
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

// ── terminal handles ────────────────────────────────────────────────────────

/**
 * Collapse terminal noise for agent-facing text:
 * - runs of blank lines → at most 2
 * - runs of identical non-blank lines → one line + "（重复 N 行）"
 * - optional line cap (tail wins) with a truncation marker
 */
function compactLines(text, maxLines) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  let blankRun = 0;
  let repeated = null;
  const pushRepeated = () => {
    if (repeated === null) return;
    out.push(repeated.count > 1 ? `${repeated.line}（重复 ${repeated.count} 行）` : repeated.line);
    repeated = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      pushRepeated();
      blankRun++;
      if (blankRun <= 2) out.push("");
      continue;
    }
    blankRun = 0;
    if (repeated !== null && repeated.line === line) {
      repeated.count++;
      continue;
    }
    pushRepeated();
    repeated = { line, count: 1 };
  }
  pushRepeated();
  if (maxLines !== undefined && out.length > maxLines) {
    const kept = out.slice(-maxLines);
    return `…[输出过长，仅显示最后 ${maxLines} 行]\n${kept.join("\n")}`;
  }
  return out.join("\n");
}

// ── echo rendering ──────────────────────────────────────────────────────────
// ConPTY repaints the screen with cursor-movement sequences (input echo,
// resize reflow, prompt redraws). Stripping ANSI alone concatenates those
// repaints into duplicated/garbled text, so the agent-facing echo replays
// the stream through a minimal VT state machine with per-handle persistent
// state: a screen-row model where text overwrites at (row, col), \r resets
// the column, LF moves down (scrolling at the bottom), CSI cursor movement
// (CUU/CUD/CUB/CUF/CUP) and erase sequences (K/J) are honored — so a repaint
// from home overwrites the old screen rows instead of appending to them.
// echoTail() returns the reconstructed screen with blank edge rows trimmed.

const ECHO_ROWS = 100; // reconstructed screen height (host clamps PTY rows to ≤100)

function createEchoRenderer(rows = ECHO_ROWS) {
  return { lines: [], row: 0, col: 0, maxRow: 0, rows: clampInt(rows, 5, 100, ECHO_ROWS), saved: null };
}

function feedEcho(state, text) {
  const ensureRow = () => {
    while (state.lines.length <= state.row) state.lines.push("");
  };
  const padCurrent = () => {
    if (state.lines[state.row].length < state.col) {
      state.lines[state.row] = state.lines[state.row].padEnd(state.col);
    }
  };
  const touch = () => {
    if (state.row > state.maxRow) state.maxRow = state.row;
  };
  const write = (chunk) => {
    ensureRow();
    padCurrent();
    const current = state.lines[state.row];
    const head = current.slice(0, state.col);
    const tailSlice = current.slice(state.col + chunk.length);
    state.lines[state.row] = head + chunk + tailSlice;
    state.col += chunk.length;
    touch();
  };
  const eraseRow = (mode) => {
    ensureRow();
    if (mode === 2) {
      state.lines[state.row] = "";
      state.col = 0;
    } else if (mode === 0) {
      state.lines[state.row] = state.lines[state.row].slice(0, state.col);
    } else if (mode === 1) {
      state.lines[state.row] = state.lines[state.row].slice(state.col);
      state.col = 0;
    }
  };
  const moveDown = (count) => {
    for (let k = 0; k < count; k += 1) {
      if (state.row + 1 < state.rows) {
        state.row += 1;
      } else {
        state.lines.shift(); // scroll: the oldest row drops off
      }
    }
    touch();
  };
  const moveTo = (row, col) => {
    state.row = clampInt(row, 1, state.rows, 1) - 1;
    state.col = Math.max(0, col - 1);
    touch();
  };
  const saveCursor = () => {
    state.saved = { row: state.row, col: state.col };
  };
  const restoreCursor = () => {
    if (state.saved !== null) {
      state.row = state.saved.row;
      state.col = state.saved.col;
      touch();
    }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      // escape sequence
      if (text[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < n && /[0-9;?]/.test(text[j])) {
          params += text[j];
          j += 1;
        }
        const finalByte = text[j];
        if (finalByte === undefined) {
          i = n; // truncated sequence: ignore the rest
        } else {
          const nums = params.replace(/\?/g, "").split(";").map((v) => (v === "" ? 1 : parseInt(v, 10)));
          const first = nums[0] ?? 1;
          if (finalByte === "D") {
            state.col = Math.max(0, state.col - first);
          } else if (finalByte === "C") {
            state.col = state.col + first;
          } else if (finalByte === "A") {
            state.row = Math.max(0, state.row - first);
          } else if (finalByte === "B") {
            moveDown(first);
          } else if (finalByte === "H" || finalByte === "f") {
            moveTo(first, nums[1] ?? 1);
          } else if (finalByte === "G") {
            // CHA: cursor horizontal absolute
            state.col = Math.max(0, first - 1);
          } else if (finalByte === "d") {
            // VPA: vertical position absolute
            state.row = Math.min(state.rows - 1, Math.max(0, first - 1));
            touch();
          } else if (finalByte === "s") {
            saveCursor();
          } else if (finalByte === "u") {
            restoreCursor();
          } else if (finalByte === "K") {
            // EL: erase-in-line. The default (no param) is 0 = "erase to end
            // of line", NOT 1. The shared `nums` mapping turns "" into 1,
            // which would mean "erase from start to cursor" and wipe the whole
            // line during ConPTY resize reflows (each re-emitted line ends
            // with \x1b[K). Re-derive the mode from the raw params here.
            const kraw = params.replace(/\?/g, "").split(";")[0];
            eraseRow(kraw === "" ? 0 : (parseInt(kraw, 10) || 0));
          } else if (finalByte === "J") {
            // ED: erase-in-display. Only 2 (clear all) resets the visible
            // screen. 3 clears scrollback only and must NOT wipe the visible
            // screen (ConPTY emits it during resize reflows).
            if (first === 2) {
              state.lines = [];
              state.row = 0;
              state.col = 0;
              state.maxRow = 0;
            }
          }
          // anything else (SGR, …) is cosmetic: skip
          i = j + 1;
        }
      } else if (text[i + 1] === "]") {
        // OSC (titles, hyperlinks…): skip to BEL or ST
        let j = i + 2;
        while (j < n && text[j] !== "\u0007") {
          if (text[j] === "\u001b" && text[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        i = Math.min(n, j + (text[j] === "\u0007" ? 1 : 0));
      } else if (text[i + 1] === "7") {
        // ESC 7: DEC save cursor
        saveCursor();
        i += 2;
      } else if (text[i + 1] === "8") {
        // ESC 8: DEC restore cursor
        restoreCursor();
        i += 2;
      } else {
        i += 2; // plain ESC + one char: skip both
      }
    } else if (code === 0x0d) {
      state.col = 0; // carriage return: overwrite from column 0
      i += 1;
    } else if (code === 0x0a) {
      moveDown(1); // line feed: next row, column kept (VT semantics)
      i += 1;
    } else if (code === 0x08) {
      state.col = Math.max(0, state.col - 1);
      i += 1;
    } else if (code === 0x09) {
      const nextCol = state.col + 8 - (state.col % 8);
      write(" ".repeat(nextCol - state.col));
      i += 1;
    } else if (code >= 0x20 && code !== 0x7f) {
      const point = text.codePointAt(i);
      const char = String.fromCodePoint(point);
      write(char);
      i += char.length;
    } else {
      i += 1; // other control chars: ignore
    }
  }
  return state;
}

function echoTail(state) {
  const end = Math.min(state.maxRow, state.lines.length - 1);
  if (end < 0) return "";
  let firstRow = 0;
  let lastRow = end;
  while (firstRow < lastRow && state.lines[firstRow].trim() === "") firstRow += 1;
  while (lastRow > firstRow && state.lines[lastRow].trim() === "") lastRow -= 1;
  return state.lines.slice(firstRow, lastRow + 1).join("\n");
}

class TerminalHandle {
  constructor(manager, sessionId, spec) {
    this.manager = manager;
    this.sessionId = sessionId;
    this.id = `term-${++manager.seq}`;
    this.name = spec.name;
    this.shell = spec.shell;
    this.cwd = spec.cwd;
    this.createdAt = Date.now();
    this.buf = "";
    this.dropped = 0;
    this.exit = null;
    this.userKilled = false;

    // spec.pty is a test-only injection point (test-host.mjs): when present,
    // no real ConPTY is spawned and the mock object stands in for node-pty.
    let termProcess = spec.pty ?? null;
    if (termProcess === null) {
      try {
        termProcess = pty.spawn(spec.file, spec.args, {
          name: "xterm-256color",
          cols: spec.cols,
          rows: spec.rows,
          cwd: spec.cwd,
          env: process.env,
        });
      } catch (error) {
        throw new Error(`无法启动 ${SHELLS[spec.shell]?.label ?? spec.shell}: ${error?.message ?? error}`);
      }
    }
    this.pty = termProcess;
    this.pid = this.pty.pid;
    this.pty.onData((data) => this.onData(typeof data === "string" ? data : String(data)));
    this.pty.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
  }

  onData(data) {
    if (data.length === 0) return;
    this.buf += data;
    if (this.buf.length > RING_MAX) {
      const cut = this.buf.length - RING_MAX;
      this.buf = this.buf.slice(cut);
      this.dropped += cut;
    }
  }

  onExit(exitCode, signal) {
    if (this.exit !== null) return;
    this.exit = { exitCode: exitCode ?? null, signal: signal ?? null };
    const controlC = this.exit.exitCode === -1073741510; // 0xC000013A: STATUS_CONTROL_C_EXIT
    const failed = this.exit.exitCode !== null && this.exit.exitCode !== 0 && !controlC && !this.userKilled;
    const reason = this.userKilled
      ? "（用户关闭）"
      : controlC
        ? "（用户按 Ctrl+C 退出）"
        : this.exit.exitCode !== null ? `，exit code: ${this.exit.exitCode}` : this.exit.signal !== null ? `，signal: ${this.exit.signal}` : "";
    this.manager.pushAgentMessage(
      this.sessionId,
      `[${this.name} | ${this.shell} | ${this.cwd}]\n状态: 已退出${reason}。需要完整输出时可用 terminal_read 工具读取（id: ${this.id}）。`,
      { wake: failed && !this.userKilled },
    );
    this.manager.scheduleRemoval(this.sessionId, this.id);
  }

  write(data) {
    if (this.exit !== null) throw new Error(`${this.name} 已退出，无法写入`);
    this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.exit !== null) return;
    this.pty.resize(cols, rows);
  }

  kill() {
    if (this.exit !== null) return;
    this.userKilled = true;
    try {
      this.pty.kill();
    } catch {
      // onExit still settles removal; never throw through RPC
    }
    this.manager.scheduleRemoval(this.sessionId, this.id);
  }

  read(after) {
    const start = Math.max(typeof after === "number" && Number.isFinite(after) ? after : 0, this.dropped);
    const text = this.buf.slice(start - this.dropped);
    return { text, offset: this.dropped + this.buf.length, exit: this.exit };
  }

  dispose() {
    this.kill();
  }
}

// ── manager ─────────────────────────────────────────────────────────────────

export class TerminalManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.seq = 0;
    this.bySession = new Map();
    this.removalTimers = new Map();
  }

  agentFor(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    if (agent === undefined || typeof agent.inject !== "function" || typeof agent.steer !== "function") return undefined;
    return agent;
  }

  pushAgentMessage(sessionId, text, { wake }) {
    const agent = this.agentFor(sessionId);
    if (agent === undefined) return;
    try {
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-terminal", form: wake ? "terminal-event" : "terminal-echo" },
      });
      // wake 时用 steer 而不是 followup：followup 会唤醒并可能抢占/取消当前
      // 正在执行的工具调用，从而把这条用户消息插到 assistant(tool_calls) 与
      // tool_result 之间。steer 在智能体运行中只会在下一个 step 边界被消费
      // （不打断工具调用），空闲时则照常唤醒，因此不会破坏 DeepSeek 接口要求
      // 的「工具结果必须紧跟工具调用」相邻关系。
      if (wake) agent.steer(message);
      else agent.inject(message);
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-terminal: agent message failed: ${error?.message ?? error}`);
    }
  }

  cwdFor(sessionId) {
    const session = this.ctx.sessions.get(sessionId);
    const cwd = session?.header?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) {
      try {
        if (existsSync(cwd)) return cwd;
      } catch {
        // fall through
      }
    }
    return process.cwd();
  }

  create(sessionId, request) {
    const kind = typeof request?.shell === "string" && request.shell in SHELLS ? request.shell : "powershell";
    const resolved = resolveShell(kind);
    const cwd = this.cwdFor(sessionId);
    // Reuse the smallest free 终端N number among the session's current
    // handles, so closing 终端1/终端2 makes the next one 终端1 again.
    const used = new Set();
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) {
      for (const handle of existing.values()) used.add(handle.name);
    }
    let n = 1;
    while (used.has(`终端${n}`)) n += 1;
    const handle = new TerminalHandle(this, sessionId, {
      file: resolved.file,
      args: resolved.args,
      shell: kind,
      cwd,
      cols: clampInt(request?.cols, 20, 300, 100),
      rows: clampInt(request?.rows, 5, 100, 28),
      name: `终端${n}`,
      pty: request?.pty ?? undefined, // test-only injection
    });
    let map = this.bySession.get(sessionId);
    if (map === undefined) {
      map = new Map();
      this.bySession.set(sessionId, map);
    }
    map.set(handle.id, handle);
    return { id: handle.id, pid: handle.pid, shell: handle.shell, cwd, name: handle.name };
  }

  requireHandle(sessionId, id) {
    const handle = this.bySession.get(sessionId)?.get(id);
    if (handle === undefined) throw new Error(`终端 ${id} 不存在（可能已被关闭）`);
    return handle;
  }

  write(sessionId, id, data) {
    if (typeof data !== "string" || data.length === 0) return;
    this.requireHandle(sessionId, id).write(data);
  }

  resize(sessionId, id, cols, rows) {
    this.requireHandle(sessionId, id).resize(clampInt(cols, 20, 300, 100), clampInt(rows, 5, 100, 28));
  }

  read(sessionId, id, after) {
    return this.requireHandle(sessionId, id).read(after);
  }

  kill(sessionId, id) {
    this.requireHandle(sessionId, id).kill();
  }

  list(sessionId) {
    const map = this.bySession.get(sessionId);
    if (map === undefined || map.size === 0) return [];
    return [...map.values()].map((handle) => ({
      id: handle.id,
      name: handle.name,
      shell: handle.shell,
      cwd: handle.cwd,
      pid: handle.pid,
      exited: handle.exit !== null,
      exitCode: handle.exit?.exitCode ?? null,
      createdAt: handle.createdAt,
    }));
  }

  notify(sessionId, id) {
    if (typeof id === "string" && id.length > 0) {
      const handle = this.requireHandle(sessionId, id);
      this.pushAgentMessage(
        sessionId,
        `[${handle.name} | ${handle.shell} | ${handle.cwd}]\n用户请求你关注此终端的当前输出。可调用 terminal_read 工具读取完整历史（id: ${handle.id}）。`,
        { wake: true },
      );
      return;
    }
    const names = this.list(sessionId).map((item) => item.name).join("、");
    this.pushAgentMessage(
      sessionId,
      names.length > 0 ? `用户请求你关注以下终端的当前输出：${names}。可调用 terminal_read 工具读取。` : "用户请求你关注终端，但当前没有打开的终端。",
      { wake: true },
    );
  }

  scheduleRemoval(sessionId, id) {
    if (this.removalTimers.has(id)) return;
    this.removalTimers.set(id, setTimeout(() => {
      this.removalTimers.delete(id);
      const map = this.bySession.get(sessionId);
      map?.delete(id);
      if (map !== undefined && map.size === 0) this.bySession.delete(sessionId);
    }, KILL_GRACE_MS));
  }

  disposeAll() {
    for (const timer of this.removalTimers.values()) clearTimeout(timer);
    this.removalTimers.clear();
    for (const map of this.bySession.values()) {
      for (const handle of map.values()) handle.dispose();
    }
    this.bySession.clear();
  }
}

// ── model tools (read-only) ─────────────────────────────────────────────────

function registerTools(ctx, manager) {
  ctx.tools.register(defineTool({
    name: "terminal_list",
    description:
      "列出当前会话在聊天界面中打开的交互式终端。用户会在这类终端里执行命令；用本工具配合 terminal_read 查看终端的实时内容与历史。返回每台的 id、shell、cwd、pid 与运行状态。",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(_args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("terminal_list 需要所属智能体会话");
      const items = manager.list(agent.id);
      if (items.length === 0) return "当前没有打开的终端。";
      return items
        .map((item) => `- ${item.name}: id=${item.id}, shell=${item.shell}, cwd=${item.cwd}, pid=${item.pid > 0 ? item.pid : "n/a"}, 创建于 ${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}, ${item.exited ? `已退出 (exit ${item.exitCode})` : "运行中"}`)
        .join("\n");
    },
    presentCall: () => ({ card: "terminal", title: "列出终端" }),
  }));

  ctx.tools.register(defineTool({
    name: "terminal_read",
    description:
      "读取某个交互式终端的输出历史。先用 terminal_list 获取终端的 id。用户会在聊天界面的终端里执行命令，本工具让智能体看到终端的实时内容。输出按屏幕真实内容重建（输入回显与重绘噪声已折叠）。历史超过 limit 时可用 offset 翻页向前回溯：第一次调用 offset 省略（读尾部），之后每次把 offset 增加上一次的 limit 即可读更早的内容，直到读完整段历史。",
    parameters: {
      id: { type: "string", required: true, description: "终端 id（来自 terminal_list）" },
      limit: { type: "number", description: `最多返回的字符数（默认 ${TOOL_TAIL_DEFAULT}，最大 ${TOOL_TAIL_MAX}）` },
      offset: { type: "number", description: "从输出末尾往前跳过的字符数（分页回溯用，默认 0 = 读尾部）" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("terminal_read 需要所属智能体会话");
      const limit = clampInt(args.limit ?? TOOL_TAIL_DEFAULT, 200, TOOL_TAIL_MAX, TOOL_TAIL_DEFAULT);
      const offset = clampInt(args.offset ?? 0, 0, 4 * 1024 * 1024, 0);
      const handle = manager.requireHandle(agent.id, args.id);
      const { text, exit } = handle.read(0);
      // Window semantics: skip `offset` chars from the end. Replay the stream
      // from the START of the buffer (not from the window start): screen
      // content is the accumulation of cursor repaints over the whole
      // history, so slicing first and then replaying from an empty screen
      // misplaces rows/columns and mixes unrelated output. The reconstructed
      // screen is bounded by the real PTY row count, so the replay is cheap
      // even for a full 2 MB buffer.
      const end = Math.max(0, text.length - offset);
      const status = exit === null ? "运行中" : exit.exitCode !== null ? `已退出 (exit ${exit.exitCode})` : `已退出 (signal ${exit.signal})`;
      const state = createEchoRenderer(handle.pty?.rows ?? ECHO_ROWS);
      feedEcho(state, text.slice(0, end));
      let body = echoTail(state);
      const truncated = text.length - offset > limit;
      if (body.length > limit) {
        body = body.slice(-limit);
        const nl = body.indexOf("\n");
        if (nl !== -1) body = body.slice(nl + 1); // keep whole lines
      }
      body = compactLines(body);
      const page = offset > 0 ? `（从末尾往前第 ${offset}~${offset + limit} 字符）` : "";
      return `${handle.name} | ${handle.shell} | ${handle.cwd}\n状态: ${status}${truncated ? `\n[历史比本次窗口更长${offset > 0 ? "，可用更大的 offset 继续回溯" : "，可用 offset 翻页回溯"}]` : ""}\n---${page}\n${body}`;
    },
    presentCall: (args) => ({ card: "terminal", title: `读取 ${args.id}` }),
  }));
}

// ── Typert remote service ───────────────────────────────────────────────────

const stringSchema = z.string();
const numberSchema = z.number();

const createResultSchema = z.object({
  id: z.string(),
  pid: z.number(),
  shell: z.string(),
  cwd: z.string(),
  name: z.string(),
});
const okResultSchema = z.object({ ok: z.boolean() });
const readResultSchema = z.object({
  text: z.string(),
  offset: z.number(),
  exit: z.object({ exitCode: z.number().nullable(), signal: z.string().nullable() }).nullable(),
});
const listResultSchema = z.object({
  terminals: z.array(z.object({
    id: z.string(),
    name: z.string(),
    shell: z.string(),
    cwd: z.string(),
    pid: z.number(),
    exited: z.boolean(),
    exitCode: z.number().nullable(),
    createdAt: z.number(),
  })),
});
const shellsResultSchema = z.object({
  shells: z.array(z.object({ kind: z.string(), label: z.string(), available: z.boolean() })),
});

function param(name, wire, schema) {
  return { name, wire, source: "json", codec: { mode: "strict", typeSymbol: `dsh-terminal#${wire}`, schema } };
}

function result(symbol, schema) {
  return { mode: "strict", typeSymbol: `dsh-terminal#${symbol}`, schema };
}

const MANIFEST = {
  package: "dsh-terminal",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-terminal#terminalService/create",
      service: "terminalService",
      namespace: "terminalService",
      method: "create",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("shell", "shell", stringSchema),
        param("cols", "cols", numberSchema),
        param("rows", "rows", numberSchema),
      ],
      result: result("CreateResult", createResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/write",
      service: "terminalService",
      namespace: "terminalService",
      method: "write",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("id", "id", stringSchema),
        param("data", "data", stringSchema),
      ],
      result: result("OkResult", okResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/resize",
      service: "terminalService",
      namespace: "terminalService",
      method: "resize",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("id", "id", stringSchema),
        param("cols", "cols", numberSchema),
        param("rows", "rows", numberSchema),
      ],
      result: result("OkResult", okResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/read",
      service: "terminalService",
      namespace: "terminalService",
      method: "read",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("id", "id", stringSchema),
        param("after", "after", numberSchema),
      ],
      result: result("ReadResult", readResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/kill",
      service: "terminalService",
      namespace: "terminalService",
      method: "kill",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("id", "id", stringSchema),
      ],
      result: result("OkResult", okResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/list",
      service: "terminalService",
      namespace: "terminalService",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [param("sessionId", "sessionId", stringSchema)],
      result: result("ListResult", listResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/notify",
      service: "terminalService",
      namespace: "terminalService",
      method: "notify",
      invocation: { kind: "direct" },
      parameters: [
        param("sessionId", "sessionId", stringSchema),
        param("id", "id", stringSchema),
      ],
      result: result("OkResult", okResultSchema),
    },
    {
      id: "dsh-terminal#terminalService/shells",
      service: "terminalService",
      namespace: "terminalService",
      method: "shells",
      invocation: { kind: "direct" },
      parameters: [],
      result: result("ShellsResult", shellsResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

class TerminalGateway extends TypertRemoteService {
  constructor(ctx, manager) {
    super(ctx, "terminalService");
    this.manager = manager;
  }

  async create(sessionId, shell, cols, rows) {
    return this.manager.create(sessionId, { shell, cols, rows });
  }

  async write(sessionId, id, data) {
    this.manager.write(sessionId, id, data);
    return { ok: true };
  }

  async resize(sessionId, id, cols, rows) {
    this.manager.resize(sessionId, id, cols, rows);
    return { ok: true };
  }

  async read(sessionId, id, after) {
    return this.manager.read(sessionId, id, after);
  }

  async kill(sessionId, id) {
    this.manager.kill(sessionId, id);
    return { ok: true };
  }

  async list(sessionId) {
    return { terminals: this.manager.list(sessionId) };
  }

  async notify(sessionId, id) {
    this.manager.notify(sessionId, id);
    return { ok: true };
  }

  async shells() {
    return { shells: listShells() };
  }
}

export function apply(ctx) {
  const manager = new TerminalManager(ctx);
  new TerminalGateway(ctx, manager);
  registerTools(ctx, manager);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-terminal: typert manifest");
  ctx.effect(() => () => manager.disposeAll(), "dsh-terminal: kill all terminals");
}

// exported for unit tests (test-echo.mjs / test-host.mjs) — no gateway behavior attached
export { createEchoRenderer, feedEcho, echoTail, compactLines, TerminalHandle };
