# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting instead:
**Security tab -> "Report a vulnerability"**.

If you can't use GitHub's private reporting, open a public issue that says only that you need a private channel (no technical details), and the maintainer will reach out.

Include what you found, steps to reproduce, and the potential impact. You'll get a reply as soon as possible.

## Scope

This project runs locally:

- a Chrome extension (`extension/content-providers.js`, `extension/content-upload.js`, `extension/content-core.js`, `extension/content.js`, `extension/popup.html`, `extension/popup.js`) that runs only on the supported AI sites;
- a local MCP server (`extension/bridge.mjs`, `extension/protocol.mjs`, `extension/session-auth.mjs`, `extension/response-buffer.mjs`) that binds exclusively to `127.0.0.1` (default port `4545`, configurable via `--port`, `WEBAI_BRIDGE_PORT`, `ANTIGRAVITY_BRIDGE_PORT`, or `BRIDGE_PORT`), validates WebSocket `Origin` headers to prevent cross-site WebSocket hijacking (CSWSH), supports strict per-session 256-bit cryptographic token authentication (`WEBAI_BRIDGE_TOKEN` / `WEBAI_BRIDGE_STRICT_AUTH=1`, stored in `~/.webai-bridge/session.json` with `0600` permissions and ownership-checked cleanup), and confines file uploads to `projectRoot` (plus optional `BRIDGE_EXTRA_ROOTS`), resolving symlinks and refusing credential files, private keys, VCS internals (`.git/`), and files larger than 2 MB.

Replies from the Web AI Orchestrator are treated as untrusted proposals: the Executor inspects proposed code and verification commands for safety before writing files inside `projectRoot` or running tests/builds.

The server writes a rule block to `~/.gemini/GEMINI.md` **only when you ask for it** (`node extension/bridge.mjs --install-rule` or `BRIDGE_INSTALL_RULE=1`), and can remove it again with `--uninstall-rule`. Installing the optional orchestrator skill (`--install-skill`) is likewise explicit and opt-in.

Reports about these components, or about their dependencies, are welcome. Files and prompts you send are processed by the Web AI provider of the tab you dedicated, under that provider's terms; that is outside the scope of this project.

## Supported versions

Only the latest release receives fixes.
