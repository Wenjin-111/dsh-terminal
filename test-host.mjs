/**
 * Host-side integration tests with injected mock PTYs (no ConPTY spawn, so
 * they run in any sandbox). Covers the manager/handle/tool-read path that
 * real terminals exercise, including the reported regression "the second
 * terminal's content is unreadable".
 * Run with: node test-host.mjs
 */
import { TerminalManager, createEchoRenderer, feedEcho, echoTail, compactLines } from "./lib/index.js";

const RING_MAX = 2 * 1024 * 1024;

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  }
};

// ── mocks ───────────────────────────────────────────────────────────────────

let mockPid = 5000;
function makePty(cols = 100, rows = 28) {
  mockPid += 1;
  const p = {
    pid: mockPid,
    cols,
    rows,
    written: "",
    killed: false,
    dataHandler: null,
    exitHandler: null,
    onData(fn) {
      p.dataHandler = fn;
    },
    onExit(fn) {
      p.exitHandler = fn;
    },
    write(data) {
      p.written += data;
    },
    resize(c, r) {
      p.cols = c;
      p.rows = r;
    },
    kill() {
      p.killed = true;
      if (p.exitHandler !== null) queueMicrotask(() => p.exitHandler({ exitCode: 0, signal: null }));
    },
    emitData(text) {
      if (p.dataHandler !== null) p.dataHandler(text);
    },
    emitExit(code, signal) {
      if (p.exitHandler !== null) p.exitHandler({ exitCode: code, signal });
    },
  };
  return p;
}

const messages = [];
const ctx = {
  agents: {
    get: () => ({
      inject(msg) {
        messages.push({ wake: false, text: msg.content[0].text });
      },
      steer(msg) {
        messages.push({ wake: true, text: msg.content[0].text });
      },
    }),
  },
  sessions: { get: () => undefined },
  logger: { warn: () => {} },
};

const manager = new TerminalManager(ctx);

// The exact reconstruction the terminal_read tool performs.
function toolRead(handle, limit = 8000) {
  const { text, exit } = handle.read(0);
  const state = createEchoRenderer(handle.pty?.rows ?? 100);
  feedEcho(state, text);
  let body = echoTail(state);
  if (body.length > limit) {
    body = body.slice(-limit);
    const nl = body.indexOf("\n");
    if (nl !== -1) body = body.slice(nl + 1);
  }
  return { body: compactLines(body), exit };
}

// ── T1: the reported regression — second terminal's content must be readable
{
  const s1 = "session-1";
  const t1 = manager.create(s1, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const t2 = manager.create(s1, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  check("T1 create names 终端1/终端2", t1.name === "终端1" && t2.name === "终端2", `got ${t1.name}/${t2.name}`);

  const handle2 = manager.requireHandle(s1, t2.id);
  const stream =
    "\r\nMicrosoft Windows [版本 10.0.26200.8875]\r\n" +
    "(c) Microsoft Corporation。保留所有权利。\r\n\r\n" +
    "D:\\AI_code\\智能音箱客服>cd frontend \r\n\r\n" +
    "D:\\AI_code\\智能音箱客服\\frontend>npm run dev\r\n\r\n" +
    "> rivr-defi-dashboard@1.0.0 dev\r\n> vite\r\n\r\n" +
    "  \x1b[32mVITE v6.4.3\x1b[0m  ready in 353 ms\r\n\r\n" +
    "  ➜  Local:   http://localhost:5173/\r\n" +
    "  ➜  Network: use --host to expose\r\n" +
    "  ➜  press h + enter to show help\r\n\x1b[?25h";
  handle2.pty.emitData(stream);

  // ConPTY-style repaint from home (resize/reflow): must not duplicate content
  handle2.pty.emitData("\x1b[2J\x1b[H" + stream.replace(/\r\n/g, "\r\x1b[B"));

  const raw = manager.read(s1, t2.id, 0);
  check("T1 second terminal raw buffer non-empty", raw.text.length > 0, `len=${raw.text.length}`);

  const { body } = toolRead(handle2);
  check("T1 reconstructed contains banner", body.includes("Microsoft Windows [版本 10.0.26200.8875]"), body);
  check("T1 reconstructed contains typed command", body.includes("npm run dev"), body);
  check("T1 reconstructed contains vite output", body.includes("VITE v6.4.3") && body.includes("http://localhost:5173/"), body);
  check("T1 repaint did not duplicate banner", body.split("Microsoft Windows [版本").length - 1 === 1, body);

  // first terminal (never fed) must read empty — and that is correct behavior
  const { body: body1 } = toolRead(manager.requireHandle(s1, t1.id));
  check("T1 first terminal (no output) reads empty", body1.trim() === "", JSON.stringify(body1));
}

// ── T2: incremental read offset semantics ───────────────────────────────────
{
  const s2 = "session-2";
  const t = manager.create(s2, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const handle = manager.requireHandle(s2, t.id);
  handle.pty.emitData("first\r\n");
  const r1 = manager.read(s2, t.id, 0);
  check("T2 initial read returns content", r1.text === "first\r\n", JSON.stringify(r1.text));
  const r2 = manager.read(s2, t.id, r1.offset);
  check("T2 read after own offset is empty", r2.text === "", JSON.stringify(r2.text));
  handle.pty.emitData("second\r\n");
  const r3 = manager.read(s2, t.id, r1.offset);
  check("T2 incremental read returns only new content", r3.text === "second\r\n", JSON.stringify(r3.text));
}

// ── T3: naming recycles the smallest free number ────────────────────────────
{
  const s3 = "session-3";
  const a = manager.create(s3, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const b = manager.create(s3, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const c = manager.create(s3, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  check("T3 names 终端1/2/3", a.name === "终端1" && b.name === "终端2" && c.name === "终端3", `${a.name}/${b.name}/${c.name}`);
  // simulate the grace period passing: host removed the killed handles
  manager.bySession.get(s3).delete(a.id);
  manager.bySession.get(s3).delete(b.id);
  const d = manager.create(s3, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  check("T3 next terminal reuses 终端1", d.name === "终端1", `got ${d.name}`);
  check("T3 ids are never reused", d.id !== a.id && d.id !== b.id && d.id !== c.id, d.id);
}

// ── T4: kill grace period — readable, then removed ──────────────────────────
{
  const s4 = "session-4";
  const t = manager.create(s4, { shell: "cmd", cols:100, rows:28, pty: makePty() });
  const handle = manager.requireHandle(s4, t.id);
  handle.pty.emitData("before death\r\n");
  const beforeKill = manager.list(s4);
  check("T4 list before kill", beforeKill.length === 1 && beforeKill[0].exited === false);
  manager.kill(s4, t.id);
  check("T4 kill marks pty killed", handle.pty.killed === true);
  await new Promise((resolve) => setTimeout(resolve, 20)); // mock kill → async exit
  const during = manager.list(s4);
  check("T4 within grace the handle stays listed as exited", during.length === 1 && during[0].exited === true, JSON.stringify(during));
  const stillReadable = toolRead(handle);
  check("T4 within grace content still readable", stillReadable.body.includes("before death"), stillReadable.body);
  await new Promise((resolve) => setTimeout(resolve, 3400));
  const after = manager.list(s4);
  check("T4 after grace the handle is removed", after.length === 0, JSON.stringify(after));
  let threw = false;
  try {
    manager.requireHandle(s4, t.id);
  } catch {
    threw = true;
  }
  check("T4 after grace requireHandle throws", threw);
}

// ── T5: resize clamping ─────────────────────────────────────────────────────
{
  const s5 = "session-5";
  const t = manager.create(s5, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  manager.resize(s5, t.id, 99999, 0);
  const handle = manager.requireHandle(s5, t.id);
  check("T5 resize clamps to 300x5", handle.pty.cols === 300 && handle.pty.rows === 5, `${handle.pty.cols}x${handle.pty.rows}`);
}

// ── T6: ring buffer overflow keeps the tail, offset math stays sane ─────────
{
  const s6 = "session-6";
  const t = manager.create(s6, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const handle = manager.requireHandle(s6, t.id);
  const chunk = "x".repeat(64 * 1024);
  let fed = 0;
  while (fed < RING_MAX + 128 * 1024) {
    handle.pty.emitData(chunk);
    fed += chunk.length;
  }
  handle.pty.emitData("\r\nTAIL-MARKER\r\n");
  const r = manager.read(s6, t.id, 0);
  check("T6 buffer capped at RING_MAX", r.text.length === RING_MAX, `len=${r.text.length}`);
  check("T6 dropped counter grew", r.offset > RING_MAX, `offset=${r.offset}`);
  check("T6 tail marker preserved", r.text.includes("TAIL-MARKER"));
  const inc = manager.read(s6, t.id, r.offset - 20);
  check("T6 incremental read near the end works", inc.text.length === 20, `len=${inc.text.length}`);
}

// ── T7: exit messages — format + wake semantics ─────────────────────────────
{
  const s7 = "session-7";
  const mk = () => manager.create(s7, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });

  const before = messages.length;
  const h1 = manager.requireHandle(s7, mk().id);
  h1.pty.emitExit(-1073741510, null); // 0xC000013A
  check("T7 Ctrl+C exit: label + no wake", messages[messages.length - 1]?.text.includes("用户按 Ctrl+C 退出") && messages[messages.length - 1]?.wake === false, JSON.stringify(messages[messages.length - 1]));

  const h2 = manager.requireHandle(s7, mk().id);
  h2.pty.emitExit(1, null);
  check("T7 failed exit: exit code + wake", messages[messages.length - 1]?.text.includes("exit code: 1") && messages[messages.length - 1]?.wake === true, JSON.stringify(messages[messages.length - 1]));

  const h3 = manager.requireHandle(s7, mk().id);
  h3.pty.emitData("x");
  manager.kill(s7, h3.id);
  await new Promise((resolve) => setTimeout(resolve, 30)); // mock kill → async exit
  check("T7 user close: label + no wake", messages[messages.length - 1]?.text.includes("用户关闭") && messages[messages.length - 1]?.wake === false, JSON.stringify(messages[messages.length - 1]));
  check("T7 exit messages all use the standard header", messages.slice(before).every((m) => /^\[终端\d+ \| cmd \| .*\]$/.test(m.text.split("\n")[0])), JSON.stringify(messages.slice(before)));
}

// ── T8: session isolation ───────────────────────────────────────────────────
{
  const sa = "session-a";
  const sb = "session-b";
  const ta = manager.create(sa, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const tb = manager.create(sb, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  check("T8 each session lists only its own", manager.list(sa).length === 1 && manager.list(sb).length === 1 && manager.list(sa)[0].id === ta.id);
  let threw = false;
  try {
    manager.read(sa, tb.id, 0);
  } catch {
    threw = true;
  }
  check("T8 cross-session read throws", threw);
}

// ── T9: write guard rails ───────────────────────────────────────────────────
{
  const s9 = "session-9";
  const t = manager.create(s9, { shell: "cmd", cols: 100, rows: 28, pty: makePty() });
  const handle = manager.requireHandle(s9, t.id);
  manager.write(s9, t.id, "");
  check("T9 empty write ignored", handle.pty.written === "");
  manager.write(s9, t.id, "echo hi\r");
  check("T9 normal write forwarded", handle.pty.written === "echo hi\r", JSON.stringify(handle.pty.written));
  handle.pty.emitData("echo hi\r"); // shell echoes the written input back into the buffer
  handle.pty.emitExit(0, null);
  let threw = false;
  try {
    manager.write(s9, t.id, "x");
  } catch {
    threw = true;
  }
  check("T9 write after exit throws", threw);
  const r = manager.read(s9, t.id, 0);
  check("T9 read after exit still works and reports exit", r.exit !== null && r.text.includes("echo hi\r"), JSON.stringify(r));
}

// ── summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nALL HOST TESTS PASSED");
}
