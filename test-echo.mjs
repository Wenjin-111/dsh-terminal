/**
 * Unit tests for the terminal_read rendering pipeline (no PTY spawn; runs
 * anywhere):
 *   - feedEcho: minimal VT state machine (screen-row model: input-echo
 *     ghosts, CR overwrite, cursor movement, CSI K/J, clear screen, repaint
 *     from home overwriting old rows, scrolling, SGR/OSC stripping,
 *     progress bars)
 *   - echoTail: reconstructed screen tail with blank edge rows trimmed
 *   - compactLines: blank collapsing + repeated-line dedupe
 * Run with: node test-echo.mjs
 */
import { createEchoRenderer, feedEcho, echoTail, compactLines } from "./lib/index.js";

let failures = 0;
const check = (label, actual, expected) => {
  if (actual === expected) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
};

// ── feedEcho / echoTail ─────────────────────────────────────────────────────

{
  const s = createEchoRenderer();
  feedEcho(s, "D:\\Dsh_work> cla");
  feedEcho(s, "ear\r\n");
  check("cmd-style plain input echo", echoTail(s), "D:\\Dsh_work> claear");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "PS D:\\Dsh_work> cla\x1b[3Dclaear");
  check("cursor-left repaint (input ghost)", echoTail(s), "PS D:\\Dsh_work> claear");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "PS D:\\Dsh_work> cla\x1b[3Dear");
  check("cursor-left overwrite semantics", echoTail(s), "PS D:\\Dsh_work> ear");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "PS D:\\Dsh_work> cl\rPS D:\\Dsh_work> clear");
  check("CR overwrite (PSReadLine-style redraw)", echoTail(s), "PS D:\\Dsh_work> clear");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "abcdef\x1b[2D\x1b[1K");
  check("CSI 1K (erase start through cursor)", echoTail(s), "ef");
  feedEcho(s, "\x1b[2Kxy");
  check("CSI 2K (erase whole line)", echoTail(s), "xy");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "old line 1\nold line 2\n\x1b[2J\nnew");
  check("CSI 2J clear screen", echoTail(s), "new");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "a\x1b[31mb\x1b[0m\x1b]0;title\x07c");
  check("SGR/OSC stripped", echoTail(s), "abc");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "Progress 30%\rProgress 60%\rProgress 100%\r\n");
  check("progress bar keeps final state", echoTail(s), "Progress 100%");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "ab\bc\t!");
  check("backspace + tab expansion", echoTail(s), "ac      !");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "错误：找不到路径。\n");
  check("CJK roundtrip", echoTail(s), "错误：找不到路径。");
}

{
  // banner + prompt, then a ConPTY repaint from home: lines are separated by
  // \r (column reset) + cursor-down, not by newlines
  const s = createEchoRenderer();
  feedEcho(s, "Microsoft Windows [版本]\r\n(c) Corporation。\r\nD:\\>");
  feedEcho(s, "\x1b[HMicrosoft Windows [版本]\r\x1b[B(c) Corporation。\r\x1b[BD:\\>");
  check("CUP repaint overwrites in place", echoTail(s), "Microsoft Windows [版本]\n(c) Corporation。\nD:\\>");
}

{
  // full repaint after resize (2J + home + \r\x1b[B-separated rows)
  const s = createEchoRenderer();
  feedEcho(s, "Banner A\r\nBanner B\r\nPrompt>");
  feedEcho(s, "\x1b[2J\x1b[HBanner A\r\x1b[BBanner B\r\x1b[BPrompt>");
  check("repaint after resize stays single", echoTail(s), "Banner A\nBanner B\nPrompt>");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "a\x1b[3;1Hb");
  check("CUP fills gap rows", echoTail(s), "a\n\nb");
}

{
  const s = createEchoRenderer();
  feedEcho(s, "top\r");
  for (let k = 0; k < 105; k += 1) feedEcho(s, "\n");
  feedEcho(s, "bottom");
  check("scroll keeps the tail", echoTail(s), "bottom");
}

{
  // reflow re-emission of the same screen must not change the tail
  const s = createEchoRenderer();
  feedEcho(s, "a\r\nb\r\nc\r\n");
  const before = echoTail(s);
  feedEcho(s, "\x1b[2J\x1b[Ha\r\nb\r\nc\r\n");
  check("reflow re-emission stays stable", echoTail(s), before);
}

{
  // ConPTY resize reflow: \x1b[8;rows;cols t + home + per-line \x1b[K re-emit.
  // \x1b[K (default 0 = erase-to-end) must NOT wipe each re-emitted line.
  const s = createEchoRenderer();
  feedEcho(s, "Microsoft Windows [版本]\r\n(c) Corporation。\r\nD:\\>npm run dev\r\n> vite\r\n  VITE ready\r\n");
  feedEcho(s, "\x1b[8;34;120t\x1b[HMicrosoft Windows [版本]\x1b[K\r\n(c) Corporation。\x1b[K\r\nD:\\>npm run dev\x1b[K\r\n> vite\x1b[K\r\n  VITE ready\x1b[K\r\n\x1b[K\r\n\x1b[6;1H");
  check("ConPTY resize reflow keeps content", echoTail(s), "Microsoft Windows [版本]\n(c) Corporation。\nD:\\>npm run dev\n> vite\n  VITE ready");
}

{
  // ESC 7/8: DEC save/restore cursor
  const s = createEchoRenderer();
  feedEcho(s, "abc\x1b7def\x1b8XY");
  check("ESC 7/8 save-restore cursor", echoTail(s), "abcXYf");
}

{
  // CSI s/u: ANSI save/restore cursor
  const s = createEchoRenderer();
  feedEcho(s, "abc\x1b[sdef\x1b[uXY");
  check("CSI s/u save-restore cursor", echoTail(s), "abcXYf");
}

{
  // CSI G: cursor horizontal absolute
  const s = createEchoRenderer();
  feedEcho(s, "abc\x1b[5Gx");
  check("CSI G absolute column", echoTail(s), "abc x");
}

{
  // CSI d: vertical position absolute
  const s = createEchoRenderer();
  feedEcho(s, "a\r\nb\r\n\x1b[2dc");
  check("CSI d absolute row", echoTail(s), "a\nc");
}

{
  // renderer respects the given screen height for scrolling
  const s = createEchoRenderer(5);
  feedEcho(s, "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7");
  check("custom row count scrolls at height", echoTail(s), "3\n4\n5\n6\n7");
}

// ── compactLines ────────────────────────────────────────────────────────────

check("compactLines: dedupe + blanks", compactLines("a\na\n\n\nb", 10), "a（重复 2 行）\n\n\nb");
check("compactLines: tail cap", compactLines("1\n2\n3\n4", 2), "…[输出过长，仅显示最后 2 行]\n3\n4");

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nALL TESTS PASSED");
}
