/**
 * Host-half smoke test: drives TerminalManager with a mock cordis ctx and a
 * REAL node-pty spawn (ConPTY). Run with: node smoke-host.mjs
 */
import { TerminalManager } from "./lib/index.js";

const agents = new Map();
const fakeAgent = {
  id: "session-1",
  messages: [],
  inject(message) {
    this.messages.push({ wake: false, message });
    console.log("[agent.inject]", message.content[0].text.slice(0, 140).replaceAll("\n", " ⏎ "));
  },
  followup(message) {
    this.messages.push({ wake: true, message });
    console.log("[agent.followup]", message.content[0].text.slice(0, 140).replaceAll("\n", " ⏎ "));
  },
};
agents.set("session-1", fakeAgent);

const ctx = {
  agents: { get: (id) => agents.get(id) },
  sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  logger: { warn: (...args) => console.warn("[warn]", ...args) },
};

const manager = new TerminalManager(ctx);

console.log("1) create terminal");
const created = manager.create("session-1", { shell: "powershell", cols: 100, rows: 28 });
console.log("   created:", JSON.stringify(created));

await new Promise((resolve) => setTimeout(resolve, 1200));

console.log("2) write command");
manager.write("session-1", created.id, "echo smoke-ok\r");

await new Promise((resolve) => setTimeout(resolve, 1200));

console.log("3) read tail");
const snapshot = manager.read("session-1", created.id, 0);
console.log("   offset:", snapshot.offset, "| exit:", JSON.stringify(snapshot.exit));
console.log("   text contains smoke-ok:", snapshot.text.includes("smoke-ok"));
console.log("   text tail:", JSON.stringify(snapshot.text.slice(-120)));

console.log("4) list");
console.log("   ", JSON.stringify(manager.list("session-1")));

console.log("5) resize + write again");
manager.resize("session-1", created.id, 120, 32);
manager.write("session-1", created.id, "echo resized-$([console]::WindowWidth)\r");

await new Promise((resolve) => setTimeout(resolve, 1200));
const after = manager.read("session-1", created.id, snapshot.offset);
console.log("   delta contains resized-120:", after.text.includes("resized-120"));

console.log("6) agent messages so far:", fakeAgent.messages.length, "(expect >= 1 echo)");

console.log("6.5) flood test (10 quick echoes → compacted injection)");
const beforeFlood = fakeAgent.messages.length;
for (let i = 0; i < 10; i++) manager.write("session-1", created.id, "echo flood\r");
await new Promise((resolve) => setTimeout(resolve, 1500));
const floodMessages = fakeAgent.messages.slice(beforeFlood);
console.log("   injected messages during flood:", floodMessages.length);
for (const entry of floodMessages) {
  const body = entry.message.content[0].text;
  console.log("   body chars:", body.length, "| lines:", body.split("\n").length);
  console.log("   tail:", JSON.stringify(body.slice(-260)));
}

console.log("7) notify agent");
manager.notify("session-1", created.id);
console.log("   agent messages now:", fakeAgent.messages.length, "| last wake:", fakeAgent.messages.at(-1)?.wake);

console.log("8) kill + exit followup");
manager.kill("session-1", created.id);
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log("   agent messages:", fakeAgent.messages.length, "| wake events:", fakeAgent.messages.filter((m) => m.wake).length);

console.log("9) disposeAll");
manager.disposeAll();
console.log("SMOKE DONE");
process.exit(0);
