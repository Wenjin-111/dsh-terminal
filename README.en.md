# dsh-terminal

A DSH bundle plugin that opens interactive terminals (node-pty + xterm.js) in the chat UI, so the agent can inspect terminal content on demand.

## Features

- Floating terminal window (in the `shell.overlay` layer): drag the title bar to move, drag the bottom-right handle to resize; position and size persist (localStorage); the `>_` button toggles visibility
- Multiple terminals per session (tabbed)
- Shell types: PowerShell / PowerShell 7 (pwsh) / Command Prompt (auto-detected, default PowerShell)
- Terminal processes run inside the gateway process via node-pty (Windows ConPTY); they are session-scoped and survive page refreshes
- **The agent inspects terminals on demand (no auto-injection)**:
  - Terminal output is NOT injected into the agent context automatically; the agent pulls content via two read-only tools `terminal_list` / `terminal_read` (`terminal_read` supports `offset` pagination for long output, reconstructed through a VT state machine with no echo/repaint noise)
  - A status message is sent when a terminal exits (wakes the agent only on a non-zero exit that the user did not trigger)
  - The panel's "Ask the agent to look" button wakes the agent, which then calls `terminal_read` itself
- Light/dark theme follows DSW tokens automatically

## Installation

Install from GitHub (recommended):

```bash
dsh plugin --profile web add github:Wenjin-111/dsh-terminal
```

Or use the full git URL:

```bash
dsh plugin --profile web add git+https://github.com/Wenjin-111/dsh-terminal.git
```

`dsh plugin add` forwards its arguments to pnpm inside the profile and reconciles the bundle list afterwards: because this package declares `dsh.bundle`, `dsh-terminal` is appended to `dsh.profile.bundles` automatically.

`lib/client.js` is committed pre-built, so a git install needs no build step; the package has no `prepare`/`install` script, so no `allowBuilds` entry is needed in the profile's `pnpm-workspace.yaml`.

**Restart the gateway for it to take effect**: restart the `dsh web` process (this disconnects the current session).

> Dependencies: the host depends on `@lydell/node-pty` (platform binaries are pre-packed via its optionalDependencies, no install script), `@deepseek-ai/dsh-typert-protocol`, and `zod`. The plugin does not depend on `dsh-tools` / `dsh-llm` directly; tool registration and message construction go through `ctx`-injected services, avoiding a second fork of host packages in the profile that would make module-level `Symbol`s mismatch.

## Usage

1. After restarting, refresh the page; a `>_` button appears at the bottom-right of the composer — click it to show/hide the terminal window
2. Drag the title bar to move the window; drag the bottom-right handle to resize (min 340×220); position and size are remembered across refreshes
3. Choose the shell type in the header, click `+` to create a terminal (working directory = the current session workspace)
4. Run commands directly; switch tabs for multiple terminals; close with `×`
5. "Ask the agent to look": makes the agent read the current terminal output immediately (it calls `terminal_read`)
6. Agent side: call `terminal_list` / `terminal_read` whenever needed; a notice arrives on terminal exit or when "Ask the agent to look" is clicked

## Uninstall

```bash
dsh plugin --profile web remove dsh-terminal
# restart the gateway again for the entry point to disappear
```

## Development

When modifying the source locally, clone and install dependencies first:

```bash
git clone https://github.com/Wenjin-111/dsh-terminal.git
cd dsh-terminal
npm install          # installs devDependencies (esbuild, xterm) and host deps
npm run build:client # bundles src/client.jsx into lib/client.js
```

Install a local checkout into the profile (symlink; after editing code, just restart the gateway — no need to re-add):

```bash
dsh plugin --profile web add link:./dsh-terminal   # local path relative to the current directory
```

- Host half: `lib/index.js` (PTY management + terminalService RPC + agent injection + tool registration)
- Client half source: `src/client.jsx` (xterm.js + addon-fit + addon-web-links bundled into client.js)
- Host smoke test: `node smoke-host.mjs` (spawns a real PowerShell to verify PTY/buffer/injection)
- Unit/integration tests: `node test-echo.mjs`, `node test-host.mjs`

## Known limitations

- Terminal sessions live only in the gateway process: restarting the gateway drops all terminals
- Terminals are bound to a session id: switching sessions shows that session's own terminal list
- On Windows the default is PowerShell 5.1; PowerShell 7 is only selectable if pwsh 7 is installed
- The agent is read-only toward terminals (no execution); commands the user types run with the gateway process's permissions (same as a local terminal)

## Security note

A terminal = running arbitrary commands on this machine. The plugin provides no extra isolation: what the user types in the terminal is equivalent to running it in a system terminal.
