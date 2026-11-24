# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Obsidian Signal UI & restored Shadow-DOM Floating Pill**: Redesigned `extension/popup.html` and `extension/popup.js` with an Obsidian Signal dark palette, tabular telemetry grid (`Provider`, `Tab Mode`, `Upload State`, `Active Job`), show/hide `#toggleTokenBtn`, Enter-to-save, CSS semantic status badges, `:focus-visible`, and `prefers-reduced-motion`; added `FloatingBridgePill` (isolated Shadow DOM, viewport-clamped drag persistence in `webai_bridge_pill_pos`, one-click Live ↔ Standby / Reclaim toggle via `webai_bridge_dedicated`) in `extension/content.js` backed by `BridgeContentRuntime.setDedicated()` / `disconnect()` / `onStateChange()` in `extension/content-core.js`, plus Milestone 4.10 tests and doctor checks.
- **Orphan-process watchdog (`startParentWatchdog`)**: Periodically verifies `process.ppid` (opt-out via `BRIDGE_NO_WATCHDOG=1`) so orphaned bridge instances exit cleanly if the IDE terminates without closing `stdin`.
- **Resilient `EADDRINUSE` bind retry loop**: Retries WebSocket binding up to 10 attempts (`BIND_MAX_ATTEMPTS = 10`, `BIND_RETRY_DELAY_MS = 1000`) and exits non-zero cleanly if the port remains permanently occupied.
- **Opt-in file logging (`BRIDGE_LOG_FILE`)**: Appends timestamped PID-tagged diagnostics when configured (`*.log` ignored in `.gitignore`).
- **Large-prompt auto-attachment fallback**: Automatically converts oversized inline prompts (`> 20,000` chars) into a `.txt` attachment merged cleanly with any existing attachments in `content-core.js`.
- **Binary-safe attachment encoding (`readAttachmentFile`)**: Detects binary files (PNG, PDF, archives, or NUL-byte buffers) and transmits them as `base64` with accurate MIME types without corrupting them with text headers.
- **Startup stall detection (`DEFAULT_STARTUP_TIMEOUT_MS = 45000`)**: Fails fast with `GENERATION_NOT_STARTED` if generation never begins instead of holding `isBusy` for 10 minutes.
- **Patch, incremental diff, slice & log compaction engine (`extension/patch-delta.mjs`)**: Added non-destructive bridge-side dry-run verification (`[patch_check ok=... failed=...]`) for `PATCH:` (`SEARCH/REPLACE`), `DELETE:`, and `RENAME:` directives; bounded LRU `sentFileSnapshots` unified diffs (`file_mode: "auto" | "diff" | "full"`); `path:start-end` line-range slicing in `filePaths`; follow-up `git diff --stat`; `.webaiignore` / `BRIDGE_CONTEXT_EXCLUDE` filtering; and verbose TAP/test log compaction.
- **Mechanical closed-loop tracking & telemetry**: Added `hasTaskCompleteSignal()` (ignoring mentions inside fenced code blocks), `loop=continue|complete` + `[loop=continue]` directive and `in_tok`/`out_tok`/`saved_tok`/`ms` counters in `[orchestrator ...]` envelopes, plus cumulative `sessionMetrics` in `orchestrator_status`.
- **Expanded test & doctor coverage**: Added `test/patch-delta.test.mjs`, canonical port `4545` and modular file checks to `scripts/doctor.mjs`, plus unit/E2E/live regression tests covering `orchestrator_status({ inspect: true })`, `orchestrator_status({ jobId })`, `get_last_response`, binary `.png` attachments, `session.json` ownership cleanup, Tier 1/Tier 2 uploads, large-prompt fallback, multi-tab replacement suppression, composer-container diagnostics, slices, incremental diffs, `[patch_check ...]`, and `loop=continue|complete`.

### Changed
- **Canonical default port unified to `4545`**: Aligned `extension/session-auth.mjs`, `extension/content-core.js`, `extension/popup.js`, `extension/popup.html`, `scripts/doctor.mjs`, and docs on port `4545` (still overridable via `--port`, `WEBAI_BRIDGE_PORT`, `ANTIGRAVITY_BRIDGE_PORT`, or `BRIDGE_PORT`).
- **Token-optimized MCP schema, prompts & WS transport**: Hid deprecated legacy tool aliases from `tools/list` by default (opt-in via `BRIDGE_SHOW_LEGACY_TOOLS=1`; runtime resolution preserved), deduplicated `MCP_INSTRUCTIONS` / `CONSULT_DESCRIPTION` / `--install-rule` (`MANAGED_RULE_POINTER`) / `SKILL.md`, replaced verbose prompt banners with compact XML tags (`<role>`, `<context>`, `<files>`, `<task>`, `<output>`) and 1-line follow-up headers, introduced hybrid `PATCH:`/`FILE:` `output_mode` (`auto` | `patch` | `full` | `analysis`), raised the inline briefing upload threshold to `10,000` chars, priority-tiered `autoDiscoverProjectContext()` (`18,000`-char default cap, trimmed `package.json`, self-rule/skill/lockfile exclusions, `context_mode`), and eliminated 3x WebSocket `promptPayload` attachment duplication.
- **Dynamic popup version display**: `extension/popup.html` and `extension/popup.js` now read the extension version dynamically from `chrome.runtime.getManifest().version` and guard all `chrome.tabs.sendMessage` callbacks against `chrome.runtime.lastError`.
- **Protocol & documentation alignment**: Reconciled `CONSULT_DESCRIPTION`, `SECURITY.md`, and `README.md` to clarify autonomous project test/build verification after safety inspection, and tightened `npm run audit` to `--audit-level=moderate`.

### Security
- Updated `@modelcontextprotocol/sdk` (`^1.32.2`), `ws` (`^8.23.0`), and patched transitive `hono` / `@hono/node-server` advisories (`npm audit`: 0 vulnerabilities).
- Switched `getGitContext()` in `extension/bridge.mjs` from `execSync` to `execFileSync`.
- Persisted `~/.webai-bridge/session.json` atomically only after `wss` emits `listening`, with `sessionId`/PID ownership checks on cleanup so a failed secondary instance cannot overwrite or delete an active bridge's session file.

### Fixed
- Fixed missing `PROTOCOL_VERSION` import in `extension/bridge.mjs` that caused a `ReferenceError` on `orchestrator_status({ inspect: true })` and `orchestrator_status({ jobId })`.
- Fixed `setupProcessLifecycle()` in `extension/bridge.mjs` to exit cleanly on `process.stdin` `end`/`close`, ensuring Windows `StdioClientTransport.close()` removes `session.json` cleanly before `SIGTERM`/`TerminateProcess`.
- Fixed `isMainModule()` in `extension/bridge.mjs` using `fileURLToPath(import.meta.url)` and removed unused `os` import.
- Fixed `get_last_response` fallthrough in `extension/bridge.mjs` so an empty cache/chat returns `BAD_REQUEST` instead of sending `"get_last_response"` as a live prompt.
- Wrapped WebSocket `browserSocket.send()` calls in `try/catch` to avoid leaked listeners or stuck `PENDING` jobs.
- Fixed `extension/content-providers.js` `extractCleanResponse()` so leading speaker-label stripping is anchored at the start of text and scoped strictly to ChatGPT, preventing mid-body truncation on code blocks across all providers; prioritized assistant-scoped ChatGPT `responseSelectors`; guarded `doc && doc.body` in Gemini's send resolver; removed all residual hashed DeepSeek CSS classes (`_27c9245`, `aaff8b8f`, `_77cefa5`).
- Fixed `extension/content-upload.js` Tier 1 stale-input preservation on follow-up turns, Tier 2 missing `triggerBtn.click()` + lazy `<input type="file">` polling, Tier 3 `DragEvent('drop')` fallback, and baseline chip-delta / composer-scoped verification (eliminating false positives from prior turns and `document.body`).
- Fixed `extension/content-core.js` multi-tab `{ type: "replaced" }` reconnect loops, parent composer resolution in `collectTabDiagnostics()`, and missing `busy`/`activeRequestId`/`uploadState` fields inside `check_session` payloads.
- Hardened `extension/response-buffer.mjs` prompt fingerprinting to hash full file contents and prevented late events from mutating already-settled jobs.
- Enforced fenced `patch` blocks around `PATCH:` `SEARCH/REPLACE` hunks in `buildOrchestratorFooter()` so Web AI markdown renderers never misparse `=======` delimiters as Setext headings.

## [2.4.0] - 2026-11-08

### Changed
- **Renamed to WebAI Bridge** (`webai-bridge`). The project is a fork of antigravity-universal-ai-bridge by Eyad / Trignod.ai, see `NOTICE.md`. The MCP server now identifies itself as `webai-bridge`, and the release archive is `webai-bridge.zip`.
- The floating button labels no longer mention Antigravity and its watermark reads "WebAI Bridge". Its saved position and per-tab dedication use new storage keys, so they reset once after upgrading.
- `projectRoot` is now required, absolute and must exist (no more fallback to the server's working directory).
- The global rule file `~/.gemini/GEMINI.md` is no longer written automatically. Use `node extension/bridge.mjs --install-rule` (or `BRIDGE_INSTALL_RULE=1`); the legacy block is migrated, and `--uninstall-rule` removes it. `BRIDGE_NO_AUTO_RULE` is obsolete.

### Added
- **Agent <-> Orchestrator protocol** (`extension/protocol.mjs`): the MCP `instructions` field is the single source of truth, also used for the optional rule file. Canonical tools `consult_orchestrator` and `orchestrator_status`; the former names (`consult_web_architect`, `consult_gemini_web_pro`, `get_bridge_status`) remain as deprecated aliases, hidden with `BRIDGE_HIDE_LEGACY_TOOLS=1`.
- Replies start with a one-line header (`[orchestrator protocol=1 provider=... status=ok ...]`) and failures return `isError` with `{ code, message, retryable, action }`.
- `response_type` (`code_changes` or `analysis`) so questions are no longer forced to produce code.
- `--print-instructions`, `--install-rule`, `--uninstall-rule` command line flags.
- `BRIDGE_EXTRA_ROOTS` to allow extra directories for uploads.
- Unit and end-to-end tests for the protocol and the file access policy.

### Security
- Uploads are confined to the project root (symlinks resolved), credential files and VCS internals are refused, and files larger than 2 MB are rejected. Refusals are reported back to the calling agent.
- Stale-process recovery only terminates a process whose command line is a bridge instance, instead of any Node.js process on the port.
- Requests are matched strictly by correlation id and are serialized, one prompt at a time.

### Fixed
- DeepSeek: hash-free selectors mapped to real DOM, strictly isolated send button resolver, elimination of multi-event click duplication, and prevention of fallback leakage to chat history buttons.
- ChatGPT: prioritized markdown containers, robust ProseMirror view dispatch, and thinking container filtering.
- Duplicate submission prevention: eliminated redundant Enter key events on successful button click dispatch across all providers.
- Gemini Web: `<user-query>` custom elements are strictly excluded from assistant turn detection and clean response extraction, preventing prompt echo fallback while waiting for Gemini to generate. Enriched Gemini streaming indicators (`.sparkle-container`, `loading-dots`, `mat-progress-spinner`).
- After a failed request the next call resends the full briefing instead of a delta the Web AI never received.
- Claude: attachment detection compares against a baseline taken before the upload and is scoped to the composer; DeepSeek: selectors mapped to the actual DOM.
- `test/live-integration.mjs` no longer contains a personal absolute path.

## [2.3.0] - 2026-11-08

### Added
- **Native File Attachment Upload (`uploadAttachmentsToDOM`)**: Replaces heavy text prompt DOM injection with native browser `DataTransfer`, `File` API, and synthetic `ClipboardEvent('paste')` vectors across Gemini, Claude, ChatGPT, DeepSeek, and Google AI Studio.
- **Zero Truncation Guarantee**: Complete files and project context (`00_PROJECT_CONTEXT_AND_BRIEFING.md`) are attached natively without size restrictions or truncation.
- **Diagnostic Doctor (`scripts/doctor.mjs`)**: Automated test suite and architecture auditor integrated via `npm run doctor` and `npm test`.
- **Universal Extension Sanitization**: Automatic mapping of non-standard extensions (`.mjs`, `.mdc`, etc.) to universally accepted mime-types and extensions (`.txt`).

## [2.2.0] - 2026-11-07

### Added
- **Multi-Provider Expansion**: Added support for **Google AI Studio** (`aistudio.google.com`) across `bridge.mjs`, `content.js`, and `manifest.json`.
- **Universal Tooling**: Added `consult_web_architect` as a universal tool alias and `get_bridge_status` to probe active connection state and detected model.
- **Chrome Extension Toolbar Popup**: Added interactive popup (`popup.html` and `popup.js`) to display current tab detection, dedication status, and quick links to supported AI platforms.
- **Draggable Status Pill**: Floating status pill can now be dragged anywhere on screen with coordinates persisted in `localStorage`.
- **Session Dedication Persistence**: Dedication state saved in `sessionStorage` so refreshing or opening "New Chat" maintains connectivity.
- **Automated Test Suite**: Added comparison unit tests (`test/comparison.test.mjs`) and end-to-end live integration tests (`test/live-integration.mjs`) using Node's native test runner.
- **Git Context Awareness**: Automatically appends active branch name and `git status --short` to the context bundle.

### Changed
- **Protocol & Concurrency Hardening**: Replaced raw `once("message")` listeners with UUID-based correlation IDs (`requestId`), configurable timeouts, and active WebSocket heartbeats (15s ping/pong).
- **Token & Context Budgeting**: Enforced a 60,000-character payload cap in `autoDiscoverProjectContext` to prevent browser textarea freezes.
- **Clean Response Extraction**: Filtered chain-of-thought accordions (`.thinking-process`, `.ds-markdown--thought`, `details`) and copy buttons from scraped responses.
- **Input Injection**: Upgraded input injection to use synthetic `ClipboardEvent('paste')` with `DataTransfer` fallback for ProseMirror and Lexical editors.
- **Configurable Port**: Added `BRIDGE_PORT` environment variable support and graceful `EADDRINUSE` diagnostic handling.
- **Rule Injection Opt-out**: Added `BRIDGE_NO_AUTO_RULE=1` to allow users to opt out of global `~/.gemini/GEMINI.md` rule injection.
- **CI Workflow**: Added automated `npm test` step to GitHub Actions CI.

### Fixed
- Fixed permanent promise hang/deadlock when browser tab closes or disconnects during tool execution.
- Fixed selector and streaming detection issues on Claude (`[data-is-streaming="true"]`) and ChatGPT (`.result-streaming`).
- Fixed npm audit vulnerabilities in transitive dependencies.
