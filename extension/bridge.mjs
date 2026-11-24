import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import {
    PROTOCOL_VERSION,
    MCP_INSTRUCTIONS, ORCHESTRATOR_PREAMBLE, ORCHESTRATOR_ROLE_BRIEFING, TOOL_CONSULT, TOOL_STATUS,
    OUTPUT_MODES, RULE_BEGIN, RULE_END,
    estimateTokens, hasTaskCompleteSignal, resolveOutputMode, buildTurnHeader,
    bridgeError, codedError, codeFromError, classifyTabFailure,
    buildEnvelope, buildOrchestratorFooter, buildStatus, getToolDefinitions,
    resolveToolName, validateConsultArgs, readBridgeVersion,
    detectRuleState, installRule, uninstallRule, installSkill
} from "./protocol.mjs";
import {
    parseFileSpec,
    sliceTextByLines,
    buildCompactAttachmentHeader,
    stripManagedBridgeBlock,
    trimPackageJsonForContext,
    parseIgnorePatterns,
    shouldExcludeContextRelPath,
    computeCompactUnifiedDiff,
    dryRunPatchBlocks,
    compactExecutionDeltaText
} from "./patch-delta.mjs";
import { SessionAuthManager } from "./session-auth.mjs";
import { ResponseBufferManager, JOB_STATUS } from "./response-buffer.mjs";

const BRIDGE_VERSION = readBridgeVersion(import.meta.url);
const LOG_FILE = process.env.BRIDGE_LOG_FILE || "";
const BIND_RETRY_DELAY_MS = 1000;
const BIND_MAX_ATTEMPTS = 10;
const PARENT_CHECK_MS = 5000;

function log(msg) {
    if (!LOG_FILE) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PID ${process.pid}] ${msg}\n`);
    } catch (e) {}
}

const authManager = new SessionAuthManager();
const responseBuffer = new ResponseBufferManager();
const PORT = authManager.port;

// Security: accept connections only from this machine and only from supported AI sites.
const ALLOWED_ORIGINS = new Set([
    "https://gemini.google.com",
    "https://aistudio.google.com",
    "https://claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://chat.deepseek.com"
]);
let wss = null;
let bindRetryTimer = null;
let parentWatchdogInterval = null;

const isMainModule = () => {
    try {
        if (!process.argv[1]) return false;
        const invoked = fs.existsSync(process.argv[1])
            ? fs.realpathSync(process.argv[1])
            : path.resolve(process.argv[1]);
        const current = fs.realpathSync(fileURLToPath(import.meta.url));
        return invoked === current;
    } catch (e) {
        return false;
    }
};

let browserSocket = null;
let heartbeatInterval = null;

function setupHeartbeat(ws) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    heartbeatInterval = setInterval(() => {
        if (!browserSocket || browserSocket.readyState !== 1) {
            clearInterval(heartbeatInterval);
            return;
        }
        if (browserSocket.isAlive === false) {
            browserSocket.terminate();
            browserSocket = null;
            clearInterval(heartbeatInterval);
            return;
        }
        browserSocket.isAlive = false;
        try {
            browserSocket.ping();
        } catch (e) {}
    }, 15000);
    if (heartbeatInterval.unref) heartbeatInterval.unref();
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return Boolean(e && e.code === "EPERM");
    }
}

function startParentWatchdog(onOrphan, { parentPid = process.ppid, intervalMs = PARENT_CHECK_MS } = {}) {
    if (process.env.BRIDGE_NO_WATCHDOG === "1") return null;
    if (!Number.isInteger(parentPid) || parentPid <= 1) return null;
    if (parentWatchdogInterval) clearInterval(parentWatchdogInterval);
    parentWatchdogInterval = setInterval(() => {
        if (!isProcessAlive(parentPid)) {
            log(`Parent PID ${parentPid} is no longer alive; shutting down orphaned bridge.`);
            console.error(`[Bridge Watchdog] Parent process ${parentPid} exited. Shutting down bridge.`);
            if (typeof onOrphan === "function") {
                onOrphan(0);
            } else {
                process.exit(0);
            }
        }
    }, intervalMs);
    if (parentWatchdogInterval.unref) parentWatchdogInterval.unref();
    return parentWatchdogInterval;
}

function createCleanupAndExit() {
    let exiting = false;
    return (exitCode = 0) => {
        if (exiting) return;
        exiting = true;
        log(`Shutting down bridge (exitCode=${exitCode}).`);
        authManager.cleanupSessionFile();
        if (bindRetryTimer) {
            clearTimeout(bindRetryTimer);
            bindRetryTimer = null;
        }
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (parentWatchdogInterval) {
            clearInterval(parentWatchdogInterval);
            parentWatchdogInterval = null;
        }
        if (browserSocket) {
            try { browserSocket.close(); } catch (e) {}
            browserSocket = null;
        }
        if (wss) {
            try { wss.close(); } catch (e) {}
            wss = null;
        }
        process.exit(exitCode);
    };
}

function setupProcessLifecycle(transport, cleanupAndExit) {
    const exitCleanly = () => cleanupAndExit(0);
    if (transport) {
        transport.onclose = exitCleanly;
    }
    if (process.stdin) {
        process.stdin.on("end", exitCleanly);
        process.stdin.on("close", exitCleanly);
    }
    process.on("SIGINT", exitCleanly);
    process.on("SIGTERM", exitCleanly);
    process.on("exit", () => authManager.cleanupSessionFile());
    if (typeof process.disconnect === "function") {
        process.on("disconnect", exitCleanly);
    }
}

/**
 * Parses `netstat -ano -p tcp` output and returns the PID listening on `port`, or null.
 * Language-independent: a listening socket has a foreign address ending in ":0".
 */
function parseListeningPid(netstatOutput, port, selfPid = process.pid) {
    for (const line of String(netstatOutput).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const [proto, local, foreign, , pid] = cols;
        if (!/^TCP/i.test(proto) || !foreign.endsWith(":0")) continue;
        if (!local.endsWith(`:${port}`)) continue;
        if (!/^\d+$/.test(pid) || pid === String(selfPid)) continue;
        return pid;
    }
    return null;
}

/**
 * Windows only. Terminates a stale bridge instance holding the port, but ONLY if the owning
 * process command line contains "bridge.mjs". Never kills unrelated Node.js processes.
 */
function tryKillStaleBridgeOnPort(port) {
    if (process.platform !== "win32") return false;
    try {
        const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 3000 });
        const pid = parseListeningPid(out, port);
        if (!pid) return false;
        const cmd = execFileSync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command",
             `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: "utf8", timeout: 5000 }
        );
        if (!/bridge\.mjs/i.test(cmd)) {
            console.error(`[Bridge] Port ${port} is held by PID ${pid}, which is not a bridge instance. Not terminating it.`);
            log(`Port ${port} held by non-bridge PID ${pid}; refusing to terminate.`);
            return false;
        }
        console.error(`[Bridge Auto-Recovery] Terminating stale bridge PID ${pid} on port ${port}...`);
        log(`Terminating stale bridge PID ${pid} on port ${port}.`);
        execFileSync("taskkill", ["/F", "/PID", pid], { timeout: 3000 });
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// File access policy: only files inside projectRoot (or BRIDGE_EXTRA_ROOTS) can be uploaded
// to a third-party Web AI, and never credentials / key material.
// ---------------------------------------------------------------------------
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const SENSITIVE_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube"]);
const SENSITIVE_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|kdbx|keystore)|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?)$/i;

const BINARY_MIME_TYPES = Object.freeze({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".wasm": "application/wasm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".exe": "application/octet-stream",
    ".dll": "application/octet-stream",
    ".so": "application/octet-stream",
    ".dylib": "application/octet-stream",
    ".bin": "application/octet-stream"
});

function isSensitiveRelPath(relPath) {
    const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.slice(0, -1).some(p => SENSITIVE_DIRS.has(p.toLowerCase()))) return true;
    return SENSITIVE_NAME.test(parts[parts.length - 1]);
}

function getAllowedRoots(projectRoot) {
    const roots = [projectRoot];
    if (process.env.BRIDGE_EXTRA_ROOTS) {
        roots.push(...process.env.BRIDGE_EXTRA_ROOTS.split(path.delimiter).filter(Boolean));
    }
    const real = [];
    for (const r of roots) {
        try { real.push(fs.realpathSync(path.resolve(r))); } catch (e) {}
    }
    return real;
}

/**
 * Resolves a file requested by the agent. Relative paths are resolved against projectRoot.
 * Returns { ok: true, path } or { ok: false, reason } (symlinks are resolved before checking).
 */
function resolveSafeFile(projectRoot, filePath) {
    let real;
    try {
        real = fs.realpathSync(path.resolve(projectRoot, filePath));
    } catch (e) {
        return { ok: false, reason: "file not found" };
    }
    const owner = getAllowedRoots(projectRoot).find(root => {
        const rel = path.relative(root, real);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!owner) return { ok: false, reason: "outside projectRoot" };
    if (isSensitiveRelPath(path.relative(owner, real))) return { ok: false, reason: "sensitive file (credentials, keys or VCS internals)" };
    let st;
    try { st = fs.statSync(real); } catch (e) { return { ok: false, reason: "unreadable" }; }
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
    return { ok: true, path: real };
}

const MAX_SNAPSHOT_CACHE_BYTES = 5 * 1024 * 1024;
const INLINE_CONTEXT_THRESHOLD = 10000;
const DIFF_MAX_CHURN_RATIO = 0.35;
const DIFF_MAX_TURN_AGE = 8;

function createEmptySessionMetrics() {
    return {
        turns: 0,
        inChars: 0,
        outChars: 0,
        inTokens: 0,
        outTokens: 0,
        diffsSent: 0,
        fullFilesSent: 0,
        slicesSent: 0,
        logsCompacted: 0,
        estimatedTokensSaved: 0,
        totalElapsedMs: 0
    };
}

let sessionState = {
    initializedProjects: new Set(),
    sentFileHashes: new Map(),
    sentFileSnapshots: new Map(),
    snapshotBytes: 0,
    turnCount: 0,
    jobMetaById: new Map(),
    sessionMetrics: createEmptySessionMetrics(),
    lastChatKey: null,
    lastCompletedReply: null
};

function setFileSnapshot(fullPath, hash, content, turnSent) {
    if (typeof content !== "string") return;
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_SNAPSHOT_CACHE_BYTES) return;

    const existing = sessionState.sentFileSnapshots.get(fullPath);
    if (existing) {
        sessionState.snapshotBytes -= existing.bytes;
        sessionState.sentFileSnapshots.delete(fullPath);
    }

    while (sessionState.snapshotBytes + size > MAX_SNAPSHOT_CACHE_BYTES && sessionState.sentFileSnapshots.size > 0) {
        const oldestKey = sessionState.sentFileSnapshots.keys().next().value;
        const oldest = sessionState.sentFileSnapshots.get(oldestKey);
        sessionState.sentFileSnapshots.delete(oldestKey);
        if (oldest) sessionState.snapshotBytes -= oldest.bytes;
    }

    sessionState.sentFileSnapshots.set(fullPath, { hash, content, turnSent, bytes: size });
    sessionState.snapshotBytes += size;
}

function getSessionMetricsSnapshot() {
    const m = sessionState.sessionMetrics;
    return {
        ...m,
        avgTurnMs: m.turns > 0 ? Math.round(m.totalElapsedMs / m.turns) : 0
    };
}

function resetSessionMemory() {
    sessionState.initializedProjects.clear();
    sessionState.sentFileHashes.clear();
    sessionState.sentFileSnapshots.clear();
    sessionState.snapshotBytes = 0;
    sessionState.turnCount = 0;
    sessionState.lastCompletedReply = null;
}

function getHash(content) {
    return crypto.createHash("md5").update(content).digest("hex");
}

function isBinaryBuffer(buf, fullPath) {
    const ext = path.extname(fullPath || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BINARY_MIME_TYPES, ext)) {
        return true;
    }
    const sampleLen = Math.min(buf.length, 8192);
    for (let i = 0; i < sampleLen; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

/**
 * Formats a file path into a safe, unambiguous attachment filename accepted by all Web AI providers.
 * Non-standard extensions (.mjs, .mdc, dotfiles) are suffixed with .txt so Gemini/Claude/ChatGPT never reject them.
 */
function toSafeAttachmentName(projectRoot, fullPath, index) {
    let rel = fullPath;
    if (projectRoot) {
        try {
            const candidate = path.relative(projectRoot, fullPath);
            if (candidate && !candidate.startsWith("..")) {
                rel = candidate;
            }
        } catch (e) {}
    }
    const baseFlat = rel.replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+/, "");
    const safeBase = baseFlat || `file_${index + 1}.txt`;
    const ext = path.extname(safeBase).toLowerCase();
    const universallyAcceptedExts = new Set([
        ".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".json",
        ".html", ".css", ".csv", ".xml", ".yaml", ".yml", ".sh", ".sql",
        ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"
    ]);
    if (!ext || !universallyAcceptedExts.has(ext)) {
        return `${safeBase}.txt`;
    }
    return safeBase;
}

/**
 * Reads a validated workspace file safely as UTF-8 text, a line slice, a unified diff, or base64 binary.
 */
function readAttachmentFile(normalizedRoot, fullPath, index, options = {}) {
    const rawBuf = options.rawBuf || fs.readFileSync(fullPath);
    const hash = options.hash || getHash(rawBuf);
    const relPath = normalizedRoot ? path.relative(normalizedRoot, fullPath) : path.basename(fullPath);
    const roleTag = options.roleHint === "target" ? " [TARGET]" : (options.roleHint === "reference" ? " [REF]" : "");
    const attachmentName = toSafeAttachmentName(normalizedRoot, fullPath, index);
    const ext = path.extname(fullPath).toLowerCase();

    if (isBinaryBuffer(rawBuf, fullPath)) {
        const mimeType = BINARY_MIME_TYPES[ext] || "application/octet-stream";
        return {
            hash,
            isBinary: true,
            byteLength: rawBuf.length,
            attachment: {
                name: attachmentName,
                originalPath: fullPath,
                content: rawBuf.toString("base64"),
                encoding: "base64",
                mimeType
            },
            manifestLine: `- [ATTACHED BINARY FILE: "${attachmentName}"]${roleTag} -> ${fullPath} (${rawBuf.length} bytes, ${mimeType}, base64)`
        };
    }

    const rawContent = typeof options.rawContent === "string" ? options.rawContent : rawBuf.toString("utf8");
    const compactHeader = buildCompactAttachmentHeader(relPath, fullPath);

    if (typeof options.diffText === "string" && options.diffText.length > 0) {
        const diffAttachmentName = `${attachmentName.replace(/\.txt$/i, "")}.diff.txt`;
        const wrapped = `${compactHeader} (unified diff vs last sent snapshot)\n\n${options.diffText}`;
        return {
            hash,
            isBinary: false,
            isDiff: true,
            rawContent,
            fullCharLength: rawContent.length,
            charLength: options.diffText.length,
            attachment: {
                name: diffAttachmentName,
                originalPath: fullPath,
                content: wrapped,
                encoding: "utf8",
                mimeType: "text/plain"
            },
            manifestLine: `- [ATTACHED DIFF: "${diffAttachmentName}"]${roleTag} -> ${fullPath} (${options.diffText.length} chars diff vs ${rawContent.length} chars full)`
        };
    }

    if (options.sliceSpec && options.sliceSpec.isSlice) {
        const sliced = sliceTextByLines(rawContent, options.sliceSpec.startLine, options.sliceSpec.endLine);
        const sliceTag = `L${sliced.startLine}-${sliced.endLine}`;
        const sliceName = `${attachmentName.replace(/(\.[^.]+)$/, `_${sliceTag}$1`)}`;
        const wrapped = `${compactHeader} (lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines})\n\n${sliced.text}`;
        return {
            hash,
            isBinary: false,
            isSlice: true,
            rawContent,
            fullCharLength: rawContent.length,
            charLength: sliced.text.length,
            attachment: {
                name: sliceName,
                originalPath: fullPath,
                content: wrapped,
                encoding: "utf8",
                mimeType: "text/plain"
            },
            manifestLine: `- [ATTACHED SLICE: "${sliceName}"]${roleTag} -> ${fullPath}:${sliced.startLine}-${sliced.endLine} (${sliced.text.length} chars of ${rawContent.length})`
        };
    }

    const headerWrappedContent = `${compactHeader}\n\n${rawContent}`;
    return {
        hash,
        isBinary: false,
        rawContent,
        fullCharLength: rawContent.length,
        charLength: rawContent.length,
        attachment: {
            name: attachmentName,
            originalPath: fullPath,
            content: headerWrappedContent,
            encoding: "utf8",
            mimeType: "text/plain"
        },
        manifestLine: `- [ATTACHED FILE: "${attachmentName}"]${roleTag} -> ${fullPath} (${rawContent.length} chars, COMPLETE)`
    };
}

function callBrowserTab(type, payload = {}, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        if (!browserSocket || browserSocket.readyState !== 1) {
            return reject(codedError("NO_TAB", "No browser tab is currently connected. Please click the floating button on a supported AI site to dedicate a tab."));
        }

        const id = crypto.randomUUID();
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (browserSocket) {
                browserSocket.off("message", onMessage);
                browserSocket.off("close", onClose);
                browserSocket.off("error", onError);
            }
        };

        const onMessage = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                    cleanup();
                    if (msg.error) {
                        reject(new Error(msg.error));
                    } else {
                        resolve(msg.payload !== undefined ? msg.payload : msg);
                    }
                }
            } catch (e) {}
        };

        const onClose = () => {
            cleanup();
            reject(codedError("TAB_DISCONNECTED", "Browser tab disconnected before completing the request."));
        };

        const onError = (err) => {
            cleanup();
            reject(new Error(`Browser WebSocket error: ${err.message}`));
        };

        timer = setTimeout(() => {
            cleanup();
            reject(codedError("TIMEOUT", `Bridge request '${type}' timed out after ${timeoutMs / 1000}s. Check the browser tab.`));
        }, timeoutMs);

        browserSocket.on("message", onMessage);
        browserSocket.once("close", onClose);
        browserSocket.once("error", onError);

        try {
            browserSocket.send(JSON.stringify({ id, type, payload }));
        } catch (err) {
            cleanup();
            reject(codedError("TAB_DISCONNECTED", `Failed to send '${type}' to browser tab: ${err.message}`));
        }
    });
}

function getGitContext(projectRoot) {
    try {
        const gitDir = path.join(projectRoot, ".git");
        if (!fs.existsSync(gitDir)) return "";
        const branch = execFileSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf8", timeout: 2000 }).trim();
        const status = execFileSync("git", ["status", "--short"], { cwd: projectRoot, encoding: "utf8", timeout: 2000 }).trim();
        if (!branch && !status) return "";
        return `\n--- [GIT STATUS & BRANCH] ---\nBranch: ${branch || "HEAD"}\n${status ? "Changes:\n" + status.slice(0, 2000) : "Working tree clean"}\n`;
    } catch (e) {
        return "";
    }
}

function getFollowUpGitDelta(projectRoot, maxChars = 1500) {
    try {
        const gitDir = path.join(projectRoot, ".git");
        if (!fs.existsSync(gitDir)) return "";
        const stat = execFileSync("git", ["diff", "--stat"], { cwd: projectRoot, encoding: "utf8", timeout: 2000 }).trim();
        if (!stat) return "";
        return `\n--- [GIT DIFF STAT] ---\n${stat.slice(0, maxChars)}\n`;
    } catch (e) {
        return "";
    }
}

function autoDiscoverProjectContext(projectRoot, alreadyIncludedFiles = [], maxCharsOrOpts = 18000) {
    if (!projectRoot || !fs.existsSync(projectRoot)) return "";

    const opts = typeof maxCharsOrOpts === "object" && maxCharsOrOpts !== null
        ? maxCharsOrOpts
        : { maxChars: maxCharsOrOpts, contextMode: "auto" };

    const contextMode = opts.contextMode || "auto";
    if (contextMode === "none") return "";

    const defaultCap = contextMode === "full" ? 40000 : (contextMode === "minimal" ? 6000 : 18000);
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : defaultCap;
    if (maxChars <= 0) return "";

    const perDocCap = contextMode === "full" ? 12000 : 8000;
    const dirScanCap = contextMode === "full" ? 12000 : (contextMode === "minimal" ? 0 : 4000);
    const ignorePatterns = parseIgnorePatterns(projectRoot);

    const normalizedIncluded = new Set(
        (alreadyIncludedFiles || []).map((f) => path.resolve(projectRoot, parseFileSpec(f).filePath))
    );
    let discoveredContent = "";
    let totalChars = 0;

    const appendBlock = (block) => {
        if (!block || totalChars >= maxChars) return false;
        const remaining = maxChars - totalChars;
        const clipped = block.length > remaining ? block.slice(0, remaining) : block;
        discoveredContent += clipped;
        totalChars += clipped.length;
        return true;
    };

    const gitContext = getGitContext(projectRoot);
    if (gitContext) {
        appendBlock(gitContext);
    }

    const tier1Files = ["package.json", "ARCHITECTURE.md", "STATE.md"];
    const tier2Files = [
        "ROADMAP.md", "DECISIONS.md", "SPEC.md", "REQUIREMENTS.md",
        "TODO.md", "JOURNAL.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"
    ];
    const rootContextFiles = contextMode === "minimal" ? tier1Files : [...tier1Files, ...tier2Files];

    for (const fileName of rootContextFiles) {
        if (totalChars >= maxChars) break;
        if (shouldExcludeContextRelPath(fileName, ignorePatterns)) continue;
        const resolved = resolveSafeFile(projectRoot, fileName);
        const fullPath = resolved.ok ? resolved.path : path.resolve(projectRoot, fileName);
        if (!resolved.ok || normalizedIncluded.has(fullPath)) continue;

        try {
            let content = fs.readFileSync(fullPath, "utf8");
            const isTrimmedPkg = fileName.toLowerCase() === "package.json";
            if (isTrimmedPkg) {
                content = trimPackageJsonForContext(content);
            } else if (fileName.toUpperCase() === "GEMINI.MD") {
                content = stripManagedBridgeBlock(content, RULE_BEGIN, RULE_END);
                if (!content) continue;
            }
            const clipped = content.slice(0, perDocCap);
            const block = `\n--- [AUTO-CONTEXT] ${fileName} ---\n${clipped}\n`;
            appendBlock(block);
            normalizedIncluded.add(fullPath);
            if (!isTrimmedPkg && clipped.length === content.length) {
                sessionState.sentFileHashes.set(fullPath, getHash(content));
            }
        } catch (e) {}
    }

    if (dirScanCap > 0 && totalChars < maxChars) {
        const contextDirs = [".gemini", ".claude", ".agents", ".agent", ".gsd"];
        let dirChars = 0;

        function scanDir(dirPath, depth = 0) {
            if (depth > 3 || !fs.existsSync(dirPath) || totalChars >= maxChars || dirChars >= dirScanCap) return;
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (totalChars >= maxChars || dirChars >= dirScanCap) break;
                    const fullPath = path.resolve(dirPath, entry.name);
                    const relPath = path.relative(projectRoot, fullPath);
                    if (shouldExcludeContextRelPath(relPath, ignorePatterns)) continue;

                    if (entry.isDirectory()) {
                        if (entry.name !== "node_modules" && entry.name !== ".git") {
                            scanDir(fullPath, depth + 1);
                        }
                    } else if (
                        /\.(md|txt|mdc|json|yaml|yml)$/i.test(entry.name) &&
                        !normalizedIncluded.has(fullPath) &&
                        !isSensitiveRelPath(relPath)
                    ) {
                        const stat = fs.statSync(fullPath);
                        if (stat.size <= 25000) {
                            let content = fs.readFileSync(fullPath, "utf8");
                            if (/gemini/i.test(relPath)) {
                                content = stripManagedBridgeBlock(content, RULE_BEGIN, RULE_END);
                                if (!content) continue;
                            }
                            const remainingDir = dirScanCap - dirChars;
                            const clipped = content.slice(0, Math.min(perDocCap, remainingDir));
                            const block = `\n--- [PROJECT MEMORY] ${relPath} ---\n${clipped}\n`;
                            appendBlock(block);
                            dirChars += block.length;
                            normalizedIncluded.add(fullPath);
                            if (clipped.length === content.length) {
                                sessionState.sentFileHashes.set(fullPath, getHash(content));
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        for (const dirName of contextDirs) {
            if (totalChars >= maxChars || dirChars >= dirScanCap) break;
            scanDir(path.resolve(projectRoot, dirName));
        }
    }

    return discoveredContent;
}

const server = new Server({ name: "webai-bridge", version: BRIDGE_VERSION }, {
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions({
        includeLegacy: process.env.BRIDGE_SHOW_LEGACY_TOOLS === "1" && process.env.BRIDGE_HIDE_LEGACY_TOOLS !== "1"
    })
}));

let tabQueue = Promise.resolve();
function withTabLock(task) {
    const run = tabQueue.then(task, task);
    tabQueue = run.catch(() => {});
    return run;
}

function formatConsultResolution(resolution, envelopeMeta = null) {
    const jobId = resolution && resolution.jobId;
    const meta = envelopeMeta || (jobId ? sessionState.jobMetaById.get(jobId) : null);

    if (resolution.status === "completed") {
        const replyText = resolution.text;
        const failure = classifyTabFailure(replyText);
        if (failure) {
            if (jobId) sessionState.jobMetaById.delete(jobId);
            // The Web AI never received the briefing: force a full resend on the next call.
            resetSessionMemory();
            return bridgeError(failure, replyText);
        }

        const outTokens = estimateTokens(replyText);
        const loop = hasTaskCompleteSignal(replyText) ? "complete" : "continue";
        const elapsedMs = Number.isFinite(resolution.elapsedMs)
            ? resolution.elapsedMs
            : (meta && meta.startedAt ? Date.now() - meta.startedAt : 0);

        let patchCheck = null;
        if (meta && meta.outputMode !== "analysis" && meta.projectRoot) {
            const dry = dryRunPatchBlocks(replyText, resolveSafeFile, meta.projectRoot);
            if (dry.hasOperations) {
                patchCheck = dry;
            }
        }

        if (meta && !meta.metricsRecorded) {
            meta.metricsRecorded = true;
            const m = sessionState.sessionMetrics;
            m.turns += 1;
            m.inChars += meta.inChars || 0;
            m.outChars += replyText.length;
            m.inTokens += meta.inTokens || 0;
            m.outTokens += outTokens;
            m.diffsSent += meta.filesDiff || 0;
            m.fullFilesSent += meta.fullFilesSent || 0;
            m.slicesSent += meta.slicesSent || 0;
            m.estimatedTokensSaved += meta.savedTokens || 0;
            m.totalElapsedMs += elapsedMs;
        }
        if (jobId) sessionState.jobMetaById.delete(jobId);

        let fullResponse;
        if (meta) {
            const envelope = buildEnvelope({
                provider: meta.provider || resolution.provider,
                responseType: meta.responseType,
                outputMode: meta.outputMode,
                filesSent: meta.filesSent,
                filesDiff: meta.filesDiff,
                filesUnchanged: meta.filesUnchanged,
                refused: meta.refused,
                loop,
                inTokens: meta.inTokens,
                outTokens,
                savedTokens: meta.savedTokens,
                elapsedMs,
                patchCheck
            });
            fullResponse = envelope + replyText;
        } else if (!replyText.startsWith("[orchestrator ")) {
            const envelope = buildEnvelope({
                provider: resolution.provider || "unknown",
                loop,
                outTokens,
                elapsedMs
            });
            fullResponse = envelope + replyText;
        } else {
            fullResponse = replyText;
        }
        sessionState.lastCompletedReply = fullResponse;
        return { content: [{ type: "text", text: fullResponse }] };
    }

    if (resolution.status === "partial_streaming") {
        const header = `[orchestrator protocol=${PROTOCOL_VERSION} provider=${resolution.provider || "unknown"} status=partial_streaming loop=continue jobId=${resolution.jobId}]\n\n`;
        const body = (resolution.partialText || "") + `\n\n[anti-timeout note] ${resolution.resumeInstruction}`;
        return { content: [{ type: "text", text: header + body }] };
    }

    if (resolution.status === "failed") {
        if (jobId) sessionState.jobMetaById.delete(jobId);
        resetSessionMemory();
        const code = codeFromError(resolution.error);
        return bridgeError(code, resolution.error?.message || "Job execution failed");
    }

    return bridgeError("BAD_REQUEST", resolution.error?.message || `Job "${resolution.jobId}" not found`);
}

function handleConsultRequest(args) {
    return withTabLock(() => handleConsultRequestUnlocked(args));
}

async function handleConsultRequestUnlocked(args) {
    const invalid = validateConsultArgs(args);
    if (invalid) return bridgeError("BAD_REQUEST", invalid);

    // If args.jobId is provided, directly poll/resume without dispatching a new prompt
    if (args.jobId) {
        const resolution = await responseBuffer.waitForWindowOrCompletion(args.jobId, { softTimeoutMs: args.softTimeoutMs });
        return formatConsultResolution(resolution);
    }

    if (!browserSocket || browserSocket.readyState !== 1) {
        return bridgeError("NO_TAB", "No browser tab is currently connected.");
    }

    const {
        projectRoot,
        conversation_history_and_context = "",
        task,
        filePaths = [],
        response_type: responseType = "code_changes",
        output_mode: rawOutputMode,
        context_mode: contextMode = "auto",
        file_mode: fileMode = "auto",
        target_files: targetFiles = [],
        max_context_chars: maxContextChars
    } = args;

    const outputMode = resolveOutputMode({ output_mode: rawOutputMode, response_type: responseType });

    if (task === "get_last_response" || task === "last_response") {
        if (sessionState.lastCompletedReply) {
            return { content: [{ type: "text", text: sessionState.lastCompletedReply }] };
        }
        try {
            const check = await callBrowserTab("check_session", {}, 5000);
            const full = check?.domDiagnostic?.lastResponseFull || check?.domDiagnostic?.lastResponseSnippet || "";
            if (full) return { content: [{ type: "text", text: full }] };
        } catch (e) {}
        return bridgeError("BAD_REQUEST", "No previous response found in bridge cache or active browser tab.");
    }

    if (task === "inspect_tab" || task === "inspect" || task === "diagnostics") {
        try {
            const diag = await callBrowserTab("inspect_tab", { inspect: true, includeLogs: true }, 10000);
            return { content: [{ type: "text", text: JSON.stringify(diag, null, 2) }] };
        } catch (e) {
            return { content: [{ type: "text", text: `Error inspecting tab: ${e.message}` }] };
        }
    }

    let chatInfo = { isEmptyChat: true, chatKey: "unknown", provider: "unknown" };
    try {
        const info = await callBrowserTab("check_session", {}, 10000);
        if (info) chatInfo = info;
    } catch (e) {}

    if (chatInfo.isEmptyChat || chatInfo.chatKey !== sessionState.lastChatKey) {
        resetSessionMemory();
        sessionState.lastChatKey = chatInfo.chatKey;
    }

    const normalizedRoot = path.resolve(projectRoot);
    const isFirstCallForProject = !sessionState.initializedProjects.has(normalizedRoot);
    sessionState.turnCount += 1;

    const targetSet = new Set();
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
        for (const tf of targetFiles) {
            const res = resolveSafeFile(normalizedRoot, parseFileSpec(tf).filePath);
            if (res.ok) targetSet.add(res.path);
        }
    }

    const attachments = [];
    let savedChars = 0;
    let promptText = buildTurnHeader({ isFirstTurn: isFirstCallForProject, outputMode }) + "\n";

    if (isFirstCallForProject) {
        const autoContext = autoDiscoverProjectContext(normalizedRoot, filePaths, {
            maxChars: maxContextChars,
            contextMode
        });
        const fullBriefing =
            `[SESSION BRIEFING]\n${conversation_history_and_context}\n` +
            (autoContext ? `\n[AUTO-DISCOVERED PROJECT CONTEXT]\n${autoContext}` : "");

        if (fullBriefing.length > INLINE_CONTEXT_THRESHOLD) {
            attachments.push({
                name: "00_PROJECT_CONTEXT_AND_BRIEFING.md",
                originalPath: path.join(normalizedRoot, "00_PROJECT_CONTEXT_AND_BRIEFING.md"),
                content: fullBriefing,
                encoding: "utf8",
                mimeType: "text/markdown"
            });
            promptText += `<context>\nSee attached file "00_PROJECT_CONTEXT_AND_BRIEFING.md" for full briefing and repository context.\n</context>\n\n`;
        } else {
            promptText += `<context>\n${fullBriefing.trim()}\n</context>\n\n`;
        }
        sessionState.initializedProjects.add(normalizedRoot);
    } else {
        const compactedDelta = compactExecutionDeltaText(conversation_history_and_context, 3500);
        if (compactedDelta.compacted) {
            savedChars += compactedDelta.savedChars;
            sessionState.sessionMetrics.logsCompacted += 1;
        }
        const gitDelta = contextMode === "none" ? "" : getFollowUpGitDelta(normalizedRoot);
        const deltaPayload = compactedDelta.text + gitDelta;

        if (deltaPayload.length > INLINE_CONTEXT_THRESHOLD) {
            attachments.push({
                name: "00_SESSION_DELTA_UPDATE.md",
                originalPath: path.join(normalizedRoot, "00_SESSION_DELTA_UPDATE.md"),
                content: deltaPayload,
                encoding: "utf8",
                mimeType: "text/markdown"
            });
            promptText += `<context>\nSee attached file "00_SESSION_DELTA_UPDATE.md" for the follow-up execution delta.\n</context>\n\n`;
        } else {
            promptText += `<context>\n${deltaPayload.trim()}\n</context>\n\n`;
        }
    }

    const manifestLines = [];
    const refused = [];
    let sentFiles = 0;
    let diffsSent = 0;
    let fullFilesSent = 0;
    let slicesSent = 0;
    let unchangedFiles = 0;
    let fileIndex = 0;

    for (const rawFileSpec of filePaths) {
        const spec = parseFileSpec(rawFileSpec);
        const resolved = resolveSafeFile(normalizedRoot, spec.filePath);
        if (!resolved.ok) {
            manifestLines.push(`- [REFUSED: ${resolved.reason}] ${rawFileSpec}`);
            refused.push(`${rawFileSpec} (${resolved.reason})`);
            continue;
        }
        const fullPath = resolved.path;
        const roleHint = targetSet.size > 0 ? (targetSet.has(fullPath) ? "target" : "reference") : null;
        const rawBuf = fs.readFileSync(fullPath);
        const currentHash = getHash(rawBuf);
        const binary = isBinaryBuffer(rawBuf, fullPath);

        if (spec.isSlice && !binary) {
            const prepared = readAttachmentFile(normalizedRoot, fullPath, fileIndex++, {
                rawBuf,
                hash: currentHash,
                sliceSpec: spec,
                roleHint
            });
            attachments.push(prepared.attachment);
            manifestLines.push(prepared.manifestLine);
            sentFiles++;
            slicesSent++;
            savedChars += Math.max(0, (prepared.fullCharLength || 0) - (prepared.charLength || 0));
            continue;
        }

        const previousHash = sessionState.sentFileHashes.get(fullPath);
        if (!isFirstCallForProject && previousHash === currentHash) {
            manifestLines.push(`- [UNCHANGED] -> ${fullPath}`);
            unchangedFiles++;
            savedChars += rawBuf.length;
            continue;
        }

        const prevSnap = !binary ? sessionState.sentFileSnapshots.get(fullPath) : null;
        if (
            !isFirstCallForProject &&
            !binary &&
            fileMode !== "full" &&
            prevSnap &&
            (sessionState.turnCount - prevSnap.turnSent) <= DIFF_MAX_TURN_AGE
        ) {
            const utf8Content = rawBuf.toString("utf8");
            const relPath = path.relative(normalizedRoot, fullPath);
            const diffRes = computeCompactUnifiedDiff(prevSnap.content, utf8Content, relPath);
            const useDiff =
                !diffRes.fallbackFull &&
                diffRes.hunkCount > 0 &&
                (fileMode === "diff" || diffRes.changedRatio <= DIFF_MAX_CHURN_RATIO);

            if (useDiff) {
                const preparedDiff = readAttachmentFile(normalizedRoot, fullPath, fileIndex++, {
                    rawBuf,
                    rawContent: utf8Content,
                    hash: currentHash,
                    diffText: diffRes.diffText,
                    roleHint
                });
                attachments.push(preparedDiff.attachment);
                manifestLines.push(preparedDiff.manifestLine);
                sessionState.sentFileHashes.set(fullPath, currentHash);
                setFileSnapshot(fullPath, currentHash, utf8Content, sessionState.turnCount);
                sentFiles++;
                diffsSent++;
                savedChars += Math.max(0, utf8Content.length - diffRes.diffText.length);
                continue;
            }
        }

        const prepared = readAttachmentFile(normalizedRoot, fullPath, fileIndex++, {
            rawBuf,
            hash: currentHash,
            roleHint
        });
        attachments.push(prepared.attachment);
        manifestLines.push(prepared.manifestLine);
        sessionState.sentFileHashes.set(fullPath, currentHash);
        if (!prepared.isBinary && typeof prepared.rawContent === "string") {
            setFileSnapshot(fullPath, currentHash, prepared.rawContent, sessionState.turnCount);
        }
        sentFiles++;
        fullFilesSent++;
    }

    if (manifestLines.length > 0) {
        promptText += `<files>\n${manifestLines.join("\n")}\n</files>\n\n`;
    }

    promptText += `<task>\n${task}\n</task>\n\n`;
    promptText += buildOrchestratorFooter(outputMode, { isFirstTurn: isFirstCallForProject });

    const inChars = promptText.length + attachments.reduce((sum, a) => sum + (a && a.content ? a.content.length : 0), 0);
    const inTokens = estimateTokens(promptText) + attachments.reduce((sum, a) => sum + estimateTokens(a && a.content ? a.content : ""), 0);
    const savedTokens = Math.ceil(savedChars / 4);

    const { job, deduplicated } = responseBuffer.createOrAttachJob({
        prompt: promptText,
        provider: chatInfo.provider || "unknown",
        files: attachments
    });

    const jobMeta = {
        projectRoot: normalizedRoot,
        provider: chatInfo.provider,
        responseType,
        outputMode,
        filesSent: sentFiles,
        filesDiff: diffsSent,
        fullFilesSent,
        slicesSent,
        filesUnchanged: unchangedFiles,
        refused,
        inChars,
        inTokens,
        savedTokens,
        startedAt: Date.now(),
        metricsRecorded: false
    };
    sessionState.jobMetaById.set(job.jobId, jobMeta);

    if (!deduplicated) {
        const promptPayload = {
            id: job.jobId,
            requestId: job.jobId,
            jobId: job.jobId,
            type: "prompt",
            taskType: "EXECUTE_PROMPT",
            payload: { prompt: promptText, attachments }
        };
        try {
            browserSocket.send(JSON.stringify(promptPayload));
        } catch (err) {
            const sendErr = codedError("TAB_DISCONNECTED", `Failed to dispatch prompt to browser tab: ${err.message}`);
            responseBuffer.failJob(job.jobId, sendErr);
            sessionState.jobMetaById.delete(job.jobId);
            resetSessionMemory();
            return bridgeError("TAB_DISCONNECTED", sendErr.message);
        }
    }

    try {
        const resolution = await responseBuffer.waitForWindowOrCompletion(job.jobId, { softTimeoutMs: args.softTimeoutMs });
        return formatConsultResolution(resolution, jobMeta);
    } catch (err) {
        sessionState.jobMetaById.delete(job.jobId);
        resetSessionMemory();
        return bridgeError(codeFromError(err), err.message);
    }
}

async function handleStatusRequest(args = {}) {
    if (args && args.jobId) {
        const job = responseBuffer.getJob(args.jobId);
        if (!job) {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        protocol_version: PROTOCOL_VERSION,
                        bridge_version: BRIDGE_VERSION,
                        connected: Boolean(browserSocket && browserSocket.readyState === 1),
                        jobId: args.jobId,
                        status: "not_found",
                        error: `No job found with id ${args.jobId}`
                    }, null, 2)
                }]
            };
        }
        const jobPayload = {
            protocol_version: PROTOCOL_VERSION,
            bridge_version: BRIDGE_VERSION,
            connected: Boolean(browserSocket && browserSocket.readyState === 1),
            jobId: job.jobId,
            status: job.status,
            capturedChars: (job.finalText ?? job.partialText).length,
            chunksEmitted: job.chunksEmitted,
            isThinking: job.isThinking,
            elapsedMs: (job.completedAt || Date.now()) - job.createdAt
        };
        if (job.status === JOB_STATUS.COMPLETED) {
            jobPayload.text = job.finalText ?? job.partialText;
        } else if (job.status === JOB_STATUS.FAILED && job.error) {
            jobPayload.error = job.error;
        }
        return {
            content: [{
                type: "text",
                text: JSON.stringify(jobPayload, null, 2)
            }]
        };
    }

    if (!browserSocket || browserSocket.readyState !== 1) {
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: false, port: PORT, version: BRIDGE_VERSION, sessionMetrics: getSessionMetricsSnapshot() }), null, 2) }] };
    }

    // Live DOM inspection & debug logs retrieval if requested
    if (args && (args.inspect || args.includeLogs || args.selector || args.action === "inspect")) {
        try {
            const diagnostics = await callBrowserTab("inspect_tab", {
                inspect: Boolean(args.inspect || args.selector || args.action === "inspect"),
                includeLogs: Boolean(args.includeLogs !== false),
                selector: args.selector || null,
                limitLogs: Number(args.limitLogs) || 50
            }, 10000);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        protocol_version: PROTOCOL_VERSION,
                        bridge_version: BRIDGE_VERSION,
                        connected: true,
                        port: PORT,
                        provider: diagnostics?.provider?.name || "unknown",
                        sessionMetrics: getSessionMetricsSnapshot(),
                        diagnostics
                    }, null, 2)
                }]
            };
        } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: true, port: PORT, version: BRIDGE_VERSION, sessionMetrics: getSessionMetricsSnapshot(), error: `Diagnostics inspection failed: ${err.message}` }), null, 2) }] };
        }
    }

    try {
        const session = await callBrowserTab("check_session", {}, 5000);
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: true, port: PORT, version: BRIDGE_VERSION, session, sessionMetrics: getSessionMetricsSnapshot() }), null, 2) }] };
    } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: true, port: PORT, version: BRIDGE_VERSION, sessionMetrics: getSessionMetricsSnapshot(), error: err.message }), null, 2) }] };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = resolveToolName(name);
    if (!tool) {
        return bridgeError("BAD_REQUEST", `Unknown tool '${name}'. Available tools: ${TOOL_CONSULT}, ${TOOL_STATUS}.`);
    }
    if (tool.legacy) {
        console.error(`[Bridge] Tool '${name}' is deprecated; use '${tool.canonical}'.`);
    }
    if (tool.kind === "status") return handleStatusRequest(args || {});
    return handleConsultRequest(args || {});
});

function startServer() {
    log(`Starting WebAI Bridge v${BRIDGE_VERSION} on port ${PORT} (ppid=${process.ppid}).`);
    if (process.env.BRIDGE_INSTALL_RULE === "1") {
        try {
            const r = installRule();
            console.error(`[Bridge] Global rule ${r.action}: ${r.path}`);
        } catch (e) {
            console.error(`[Bridge] Could not install the global rule: ${e.message}`);
        }
    } else if (detectRuleState() === "legacy") {
        console.error("[Bridge] Legacy global rule found in ~/.gemini/GEMINI.md. Run `node bridge.mjs --install-rule` to migrate it, or `--uninstall-rule` to remove it.");
    }

    const cleanupAndExit = createCleanupAndExit();

    function initWebSocket(attempt = 1) {
        const candidateWss = new WebSocketServer({
            host: "127.0.0.1",
            port: PORT,
            maxPayload: 100 * 1024 * 1024, // 100MB max payload for large multi-file attachments
            verifyClient: (info, cb) => {
                const res = authManager.verifyUpgradeRequest(info.req);
                info.req._tokenVerifiedOnUpgrade = res.tokenVerified;
                if (typeof cb === "function") {
                    cb(res.ok, res.ok ? 200 : 403, res.reason);
                } else {
                    return res.ok;
                }
            }
        });
        wss = candidateWss;

        candidateWss.on("listening", () => {
            try {
                authManager.persistSessionFile();
            } catch (e) {
                console.error(`[Bridge] Warning: could not persist session file: ${e.message}`);
            }
            log(`WebSocket server listening on 127.0.0.1:${PORT} (attempt ${attempt}).`);
        });

        candidateWss.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                try { candidateWss.close(); } catch (_) {}
                if (wss === candidateWss) wss = null;

                if (attempt === 1 && tryKillStaleBridgeOnPort(PORT)) {
                    console.error(`[Bridge Auto-Recovery] Port ${PORT} was held by a stale process. Retrying bind in 500ms...`);
                    log(`Retrying bind on port ${PORT} after stale bridge termination.`);
                    bindRetryTimer = setTimeout(() => {
                        bindRetryTimer = null;
                        initWebSocket(attempt + 1);
                    }, 500);
                    return;
                }

                if (attempt < BIND_MAX_ATTEMPTS) {
                    console.error(`[Bridge] Port ${PORT} is in use (attempt ${attempt}/${BIND_MAX_ATTEMPTS}). Retrying in ${BIND_RETRY_DELAY_MS}ms...`);
                    log(`Port ${PORT} EADDRINUSE (attempt ${attempt}/${BIND_MAX_ATTEMPTS}); retrying.`);
                    bindRetryTimer = setTimeout(() => {
                        bindRetryTimer = null;
                        initWebSocket(attempt + 1);
                    }, BIND_RETRY_DELAY_MS);
                    return;
                }

                console.error(`[Bridge Error] Port ${PORT} is already in use after ${BIND_MAX_ATTEMPTS} attempts. Another bridge instance or process is running.`);
                console.error(`[Bridge Tip] Close lingering Node.js processes or set BRIDGE_PORT to another port (e.g. 4546).`);
                log(`Permanent bind failure on port ${PORT} after ${BIND_MAX_ATTEMPTS} attempts; exiting.`);
                cleanupAndExit(1);
                return;
            }
            console.error(`[Bridge Error] WebSocketServer error:`, err);
            log(`WebSocketServer error: ${err.message}`);
        });

        candidateWss.on("connection", (ws, req) => {
            if (req && req._tokenVerifiedOnUpgrade) {
                ws._tokenVerifiedOnUpgrade = true;
            }
            if (browserSocket && browserSocket.readyState === 1) {
                log("Replacing previously connected browser tab.");
                try {
                    browserSocket.send(JSON.stringify({ type: "replaced" }));
                } catch (e) {}
                browserSocket.close();
            }
            browserSocket = ws;
            setupHeartbeat(ws);
            log("Browser tab connected.");

            ws.on("message", (raw) => {
                let msg;
                try {
                    msg = JSON.parse(raw.toString());
                } catch (e) {
                    return;
                }
                if (!authManager.validateMessageAuth(ws, msg)) {
                    try {
                        ws.send(JSON.stringify({ type: "ERROR", code: "ERR_UNAUTHORIZED", message: "Unauthorized WebSocket message" }));
                    } catch (_) {}
                    return;
                }
                if (msg.type === "AUTH_HELLO") {
                    const res = authManager.authenticateConnection(ws, msg);
                    if (res.ok) {
                        try {
                            ws.send(JSON.stringify({ type: "AUTH_OK", sessionSecret: res.sessionSecret }));
                        } catch (_) {}
                    } else {
                        try {
                            ws.send(JSON.stringify({ type: "ERROR", code: res.code, message: res.reason }));
                        } catch (_) {}
                    }
                    return;
                }
                if (msg.type === "STREAM_CHUNK") {
                    responseBuffer.ingestStreamChunk(msg);
                    return;
                }
                if (msg.type === "RESPONSE_COMPLETE") {
                    responseBuffer.completeJob(msg.jobId || msg.requestId || msg.id, msg.text || msg.response, msg);
                    return;
                }
                if (msg.type === "ERROR") {
                    responseBuffer.failJob(msg.jobId || msg.requestId || msg.id, msg);
                    return;
                }
                // Backwards compatibility with test runners and legacy content script:
                if (msg.id && (msg.type === "prompt" || msg.reply !== undefined || msg.payload?.reply !== undefined)) {
                    const replyContent = msg.payload !== undefined && msg.payload.reply !== undefined
                        ? msg.payload.reply
                        : (msg.reply !== undefined ? msg.reply : msg.payload);
                    responseBuffer.completeJob(msg.id, typeof replyContent === "string" ? replyContent : JSON.stringify(replyContent), msg);
                }
            });

            ws.on("close", () => {
                authManager.revokeConnection(ws);
                if (browserSocket === ws) {
                    browserSocket = null;
                    log("Browser tab disconnected.");
                }
                for (const [jId, j] of responseBuffer.jobs.entries()) {
                    if (j.status === JOB_STATUS.PENDING || j.status === JOB_STATUS.STREAMING) {
                        responseBuffer.failJob(jId, codedError("TAB_DISCONNECTED", "Browser tab disconnected before completing the request."));
                    }
                }
            });
            resetSessionMemory();
        });
    }

    initWebSocket(1);
    startParentWatchdog(cleanupAndExit);

    const transport = new StdioServerTransport();
    setupProcessLifecycle(transport, cleanupAndExit);
    return server.connect(transport);
}

function runCli(argv) {
    if (argv.includes("--print-instructions")) {
        console.log(MCP_INSTRUCTIONS);
        return 0;
    }
    if (argv.includes("--install-rule")) {
        const r = installRule();
        console.log(`Global rule ${r.action}: ${r.path}`);
        return 0;
    }
    if (argv.includes("--uninstall-rule")) {
        const r = uninstallRule();
        console.log(`Global rule ${r.action}: ${r.path}`);
        return 0;
    }
    if (argv.includes("--install-skill")) {
        const r = installSkill({ metaUrl: import.meta.url });
        console.log(`Orchestrator skill ${r.action}: ${r.path}`);
        return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log("Usage: node bridge.mjs [--print-instructions | --install-rule | --uninstall-rule | --install-skill]\nWithout flags, starts the MCP server on stdio.");
        return 0;
    }
    return null;
}

if (isMainModule()) {
    const cliExit = runCli(process.argv.slice(2));
    if (cliExit !== null) {
        process.exit(cliExit);
    }
    await startServer();
}

export {
    autoDiscoverProjectContext,
    getHash,
    toSafeAttachmentName,
    readAttachmentFile,
    getGitContext,
    getFollowUpGitDelta,
    getSessionMetricsSnapshot,
    callBrowserTab,
    resetSessionMemory,
    sessionState,
    MCP_INSTRUCTIONS,
    handleConsultRequest,
    handleStatusRequest,
    ALLOWED_ORIGINS,
    PORT,
    startServer,
    resolveSafeFile,
    isSensitiveRelPath,
    parseListeningPid,
    withTabLock,
    isProcessAlive,
    startParentWatchdog,
    isMainModule,
    authManager,
    responseBuffer
};
