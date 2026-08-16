/**
 * Pre-install verification for the client bundle:
 * 1. Loads lib/client.js through a mocked window.__ModuleLoader__ and runs
 *    apply(ctx) with a mocked ctx — proves the bundle evaluates and the
 *    cordis body wires up (locale, remote contribution, both slot
 *    registrations) without a browser.
 * 2. Compares the client CONTRIBUTION descriptors against the host MANIFEST
 *    invocations (id set, methods, and per-method wire parameter names).
 *
 * Run with: node verify-client.mjs
 */
import { readFileSync } from "node:fs";

const clientCode = readFileSync(new URL("lib/client.js", import.meta.url), "utf8");

// xterm's UMD wrapper and several of its modules touch browser globals at
// load time. The bundle itself runs in a real browser; this headless harness
// provides recursive never-throwing stubs for those globals (only
// __ModuleLoader__.load is real, to capture the factory).
function makeStub(label) {
  const cache = {};
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.toStringTag) return label;
      if (typeof prop === "string" && prop in cache) return cache[prop];
      const child = makeStub(label + "." + String(prop));
      if (typeof prop === "string") cache[prop] = child;
      return child;
    },
    set(_target, prop, value) {
      if (typeof prop === "string") cache[prop] = value;
      return true;
    },
    has() {
      return true;
    },
    apply() {
      return makeStub(label + "()");
    },
    construct() {
      return makeStub(label + "[]");
    },
  });
}

let captured = null;
globalThis.self = globalThis;
globalThis.window = makeStub("window");
globalThis.document = makeStub("document");
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    if (captured !== null) throw new Error("ModuleLoader.load called twice");
    captured = entry;
  },
};

const fakeRequire = (name) => {
  if (name === "react") {
    return {
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      createElement: () => Object.freeze({}),
      Fragment: null,
    };
  }
  if (name === "react/jsx-runtime") {
    return { jsx: () => Object.freeze({}), jsxs: () => Object.freeze({}), Fragment: null };
  }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error("unexpected seed require: " + name);
};

const sandboxModule = { exports: {} };
const run = new Function("require", "module", "exports", clientCode);
run(fakeRequire, sandboxModule, sandboxModule.exports);

if (captured === null) throw new Error("bundle never called window.__ModuleLoader__.load");
if (captured.id !== "dsh-terminal") throw new Error("unexpected module id: " + captured.id);
const plugin = captured.factory(fakeRequire);
if (typeof plugin?.apply !== "function") throw new Error("factory did not return { apply }");
console.log("[1] bundle loads; factory returns apply:", typeof plugin.apply === "function");

// ── 2) drive apply() with a mocked ctx ──────────────────────────────────────

const registrations = [];
let mountedContribution = null;
const localeRegistrations = [];
const mockCtx = {
  effect(fn, label) {
    const disposer = typeof fn === "function" ? fn() : undefined;
    return () => {
      if (typeof disposer === "function") disposer();
    };
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push([ns, dicts]);
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  remote: {
    $mount(contribution) {
      mountedContribution = contribution;
      return Promise.resolve();
    },
  },
  slots: {
    inject(slotName, fn) {
      const registration = fn();
      return () => {
        if (typeof registration === "function") registration();
      };
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  get(name) {
    if (name === "sessions") return { currentProvideInfo: null };
    throw new Error("unexpected ctx.get: " + name);
  },
};

plugin.apply(mockCtx);

const slotNames = registrations.map((r) => r.options.name);
if (!slotNames.includes("conversation.input.right") || !slotNames.includes("shell.overlay")) {
  throw new Error("missing slot registrations, got: " + slotNames.join(", "));
}
console.log("[2] apply wired:", JSON.stringify({ locales: localeRegistrations.map(([ns]) => ns), slots: slotNames, contribution: mountedContribution?.package + "/" + mountedContribution?.descriptors?.length + " descriptors" }));

// ── 3) MANIFEST vs CONTRIBUTION parity ──────────────────────────────────────

const hostSource = readFileSync(new URL("lib/index.js", import.meta.url), "utf8");
const hostIds = [...hostSource.matchAll(/id: "dsh-terminal#terminalService\/[a-z]+"/g)].map((m) => m[0].match(/terminalService\/([a-z]+)"/)[1]);
const clientIds = mountedContribution.descriptors.map((d) => d.id.replace("dsh-terminal#terminalService/", ""));

const hostMethods = [...new Set(hostIds)];
const clientMethods = [...new Set(clientIds)];
const sameIds = hostMethods.length === clientMethods.length && hostMethods.every((m) => clientMethods.includes(m));
if (!sameIds) throw new Error(`descriptor id mismatch: host=[${hostMethods}] client=[${clientMethods}]`);

// per-method wire parameter parity (host: name/wire pairs in order; client: wire names in order)
for (const method of hostMethods) {
  const hostBlock = hostSource.slice(
    hostSource.indexOf(`method: "${method}"`),
    hostSource.indexOf("result:", hostSource.indexOf(`method: "${method}"`)),
  );
  const hostWires = [...hostBlock.matchAll(/param\("([a-zA-Z]+)", "([a-zA-Z]+)"/g)].map((m) => m[2]);
  const descriptor = mountedContribution.descriptors.find((d) => d.method === method);
  const clientWires = descriptor.parameters.map((p) => p.wire);
  const equal = hostWires.length === clientWires.length && hostWires.every((w, i) => w === clientWires[i]);
  if (!equal) throw new Error(`wire mismatch for ${method}: host=[${hostWires}] client=[${clientWires}]`);
}
console.log("[3] MANIFEST/CONTRIBUTION parity OK for", hostMethods.length, "methods:", hostMethods.join(", "));

console.log("VERIFY-CLIENT PASSED");
