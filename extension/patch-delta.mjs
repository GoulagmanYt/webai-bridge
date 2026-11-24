/**
 * WebAI Bridge - Patch Dry-Run, Incremental File Diff, Line-Slice & Log Compaction Engine
 * Pure Node.js ESM module (zero external dependencies).
 */
import fs from "fs";
import path from "path";

const BUILTIN_EXCLUDED_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "poetry.lock",
    "composer.lock",
    "gemfile.lock"
]);

const BUILTIN_EXCLUDED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".cache",
    ".tmp",
    "tmp",
    ".next",
    ".nuxt",
    ".turbo",
    ".pytest_cache",
    "__pycache__"
]);

const SENSITIVE_NAME_FALLBACK = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|kdbx|keystore)|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?)$/i;
const SENSITIVE_DIRS_FALLBACK = new Set([".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube"]);

/**
 * Safely parses optional trailing `:start-end` or `:line` slice syntax from a file specifier
 * without breaking Windows drive letters (e.g. `C:\repo\a.js:10-40`).
 * @param {string} rawSpec
 * @returns {{ filePath: string, startLine: number|null, endLine: number|null, isSlice: boolean }}
 */
export function parseFileSpec(rawSpec) {
    const spec = String(rawSpec || "").trim();
    if (!spec) {
        return { filePath: "", startLine: null, endLine: null, isSlice: false };
    }

    const match = spec.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (!match) {
        return { filePath: spec, startLine: null, endLine: null, isSlice: false };
    }

    const candidatePath = match[1];
    // Never treat a bare Windows drive prefix (e.g. "C:123") as a line slice
    if (/^[a-zA-Z]$/.test(candidatePath)) {
        return { filePath: spec, startLine: null, endLine: null, isSlice: false };
    }

    let startLine = Number.parseInt(match[2], 10);
    let endLine = match[3] !== undefined ? Number.parseInt(match[3], 10) : startLine;
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < 1) {
        return { filePath: spec, startLine: null, endLine: null, isSlice: false };
    }
    if (endLine < startLine) {
        const tmp = startLine;
        startLine = endLine;
        endLine = tmp;
    }

    return {
        filePath: candidatePath,
        startLine,
        endLine,
        isSlice: true
    };
}

/**
 * Slices text to an inclusive 1-based line range and prefixes each line with `lineNo| `.
 * @param {string} content
 * @param {number} startLine
 * @param {number} endLine
 * @returns {{ text: string, startLine: number, endLine: number, totalLines: number }}
 */
export function sliceTextByLines(content, startLine, endLine) {
    const normalized = String(content ?? "").replace(/\r\n/g, "\n");
    if (normalized.length === 0) {
        return { text: "", startLine: 1, endLine: 0, totalLines: 0 };
    }
    const lines = normalized.split("\n");
    const totalLines = lines.length;
    const clampedStart = Math.max(1, Math.min(totalLines, Number(startLine) || 1));
    const clampedEnd = Math.max(clampedStart, Math.min(totalLines, Number(endLine) || clampedStart));

    const out = [];
    for (let lineNo = clampedStart; lineNo <= clampedEnd; lineNo++) {
        out.push(`${lineNo}| ${lines[lineNo - 1]}`);
    }
    return {
        text: out.join("\n"),
        startLine: clampedStart,
        endLine: clampedEnd,
        totalLines
    };
}

/**
 * Builds a compact single-line attachment header replacing verbose multi-line banners.
 * @param {string} relPath
 * @param {string} fullPath
 * @returns {string}
 */
export function buildCompactAttachmentHeader(relPath, fullPath) {
    const cleanRel = String(relPath || "").replace(/\\/g, "/") || path.basename(String(fullPath || "file"));
    return `// FILE: ${cleanRel} | ${fullPath}`;
}

/**
 * Strips the bridge's own managed rule block from a file (e.g. GEMINI.md) so the bridge
 * never feeds its own Executor instructions back into the Orchestrator context.
 * @param {string} text
 * @param {string} ruleBegin
 * @param {string} ruleEnd
 * @returns {string}
 */
export function stripManagedBridgeBlock(text, ruleBegin, ruleEnd) {
    let out = String(text || "");
    if (!ruleBegin || !ruleEnd) return out;
    let safety = 0;
    while (safety++ < 20) {
        const start = out.indexOf(ruleBegin);
        if (start === -1) break;
        const end = out.indexOf(ruleEnd, start + ruleBegin.length);
        if (end === -1) break;
        out = out.slice(0, start) + out.slice(end + ruleEnd.length);
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Trims package.json to high-signal metadata fields for auto-discovered project context.
 * @param {string} rawJson
 * @returns {string}
 */
export function trimPackageJsonForContext(rawJson) {
    try {
        const parsed = JSON.parse(String(rawJson || ""));
        const keys = [
            "name", "version", "type", "engines", "main", "exports", "bin",
            "scripts", "dependencies", "devDependencies", "peerDependencies"
        ];
        const trimmed = {};
        for (const k of keys) {
            if (parsed[k] !== undefined) {
                trimmed[k] = parsed[k];
            }
        }
        return JSON.stringify(trimmed, null, 2);
    } catch (_) {
        return String(rawJson || "").slice(0, 4000);
    }
}

/**
 * Loads optional ignore patterns from `.webaiignore` in `projectRoot` and `BRIDGE_CONTEXT_EXCLUDE`.
 * @param {string} projectRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function parseIgnorePatterns(projectRoot, env = process.env) {
    const patterns = [];
    if (projectRoot) {
        const ignoreFile = path.join(projectRoot, ".webaiignore");
        try {
            if (fs.existsSync(ignoreFile)) {
                const raw = fs.readFileSync(ignoreFile, "utf8");
                for (const line of raw.split(/\r?\n/)) {
                    const cleaned = line.trim();
                    if (cleaned && !cleaned.startsWith("#")) {
                        patterns.push(cleaned);
                    }
                }
            }
        } catch (_) {}
    }

    const envRaw = env && typeof env.BRIDGE_CONTEXT_EXCLUDE === "string" ? env.BRIDGE_CONTEXT_EXCLUDE : "";
    if (envRaw.trim()) {
        for (const token of envRaw.split(/[,;]+/)) {
            const cleaned = token.trim();
            if (cleaned) patterns.push(cleaned);
        }
    }

    return patterns;
}

function globToRegExp(pattern) {
    const norm = String(pattern || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const dirOnly = norm.endsWith("/");
    const trimmed = dirOnly ? norm.slice(0, -1) : norm;

    let regexStr = "";
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "*") {
            if (trimmed[i + 1] === "*") {
                if (trimmed[i + 2] === "/") {
                    regexStr += "(?:.*/)?";
                    i += 2;
                } else {
                    regexStr += ".*";
                    i += 1;
                }
            } else {
                regexStr += "[^/]*";
            }
        } else if (ch === "?") {
            regexStr += "[^/]";
        } else {
            regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }

    const hasSlash = trimmed.includes("/");
    const prefix = hasSlash ? "^" : "(?:^|/)";
    const suffix = dirOnly ? "(?:/|$)" : "(?:/.*|$)";
    return new RegExp(`${prefix}${regexStr}${suffix}`, "i");
}

/**
 * Determines whether a relative path should be excluded from auto-discovered project context.
 * @param {string} relPath
 * @param {string[]} [extraPatterns]
 * @returns {boolean}
 */
export function shouldExcludeContextRelPath(relPath, extraPatterns = []) {
    const norm = String(relPath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
    if (!norm) return false;
    const lower = norm.toLowerCase();
    const parts = lower.split("/").filter(Boolean);
    const base = parts[parts.length - 1] || "";

    if (BUILTIN_EXCLUDED_FILES.has(base)) return true;
    if (base.endsWith(".log")) return true;
    if (parts.slice(0, -1).some((dir) => BUILTIN_EXCLUDED_DIRS.has(dir))) return true;
    // Self-exclude bundled or installed webai-orchestrator skill instructions
    if (lower.endsWith("webai-orchestrator/skill.md")) return true;

    for (const pat of extraPatterns || []) {
        if (!pat || typeof pat !== "string") continue;
        try {
            if (globToRegExp(pat).test(norm)) return true;
        } catch (_) {}
    }
    return false;
}

/**
 * Computes a compact unified diff between two text snapshots using prefix/suffix trimming
 * and a bounded LCS dynamic-programming pass. Falls back gracefully on huge rewrites.
 * @param {string} oldText
 * @param {string} newText
 * @param {string} [label="file"]
 * @param {object} [options]
 * @param {number} [options.contextLines=3]
 * @param {number} [options.maxMatrixCells=400000]
 * @returns {{ diffText: string, changedRatio: number, hunkCount: number, fallbackFull: boolean }}
 */
export function computeCompactUnifiedDiff(oldText, newText, label = "file", options = {}) {
    const contextLines = Number.isInteger(options.contextLines) ? options.contextLines : 3;
    const maxMatrixCells = Number.isInteger(options.maxMatrixCells) ? options.maxMatrixCells : 400000;

    const oldNorm = String(oldText ?? "").replace(/\r\n/g, "\n");
    const newNorm = String(newText ?? "").replace(/\r\n/g, "\n");

    if (oldNorm === newNorm) {
        return { diffText: "", changedRatio: 0, hunkCount: 0, fallbackFull: false };
    }

    const oldLines = oldNorm === "" ? [] : oldNorm.split("\n");
    const newLines = newNorm === "" ? [] : newNorm.split("\n");

    let prefix = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix < (oldLines.length - prefix) &&
        suffix < (newLines.length - prefix) &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }

    const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
    const newMid = newLines.slice(prefix, newLines.length - suffix);
    const m = oldMid.length;
    const n = newMid.length;

    if (m * n > maxMatrixCells) {
        return { diffText: "", changedRatio: 1, hunkCount: 0, fallbackFull: true };
    }

    // Build LCS length table for the differing middle region only
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
        const rowOff = i * width;
        const nextRowOff = (i + 1) * width;
        for (let j = n - 1; j >= 0; j--) {
            if (oldMid[i] === newMid[j]) {
                dp[rowOff + j] = dp[nextRowOff + j + 1] + 1;
            } else {
                const down = dp[nextRowOff + j];
                const right = dp[rowOff + j + 1];
                dp[rowOff + j] = down >= right ? down : right;
            }
        }
    }

    // Reconstruct full edit script with 1-based line coordinates
    const ops = [];
    for (let k = 0; k < prefix; k++) {
        ops.push({ type: " ", text: oldLines[k], oldLine: k + 1, newLine: k + 1 });
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (oldMid[i] === newMid[j]) {
            ops.push({ type: " ", text: oldMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            i++;
            j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
            ops.push({ type: "-", text: oldMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            i++;
        } else {
            ops.push({ type: "+", text: newMid[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            j++;
        }
    }
    while (i < m) {
        ops.push({ type: "-", text: oldMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i++;
    }
    while (j < n) {
        ops.push({ type: "+", text: newMid[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        j++;
    }

    const oldSuffixBase = oldLines.length - suffix;
    const newSuffixBase = newLines.length - suffix;
    for (let k = 0; k < suffix; k++) {
        ops.push({
            type: " ",
            text: oldLines[oldSuffixBase + k],
            oldLine: oldSuffixBase + k + 1,
            newLine: newSuffixBase + k + 1
        });
    }

    // Group changes into unified hunks with `contextLines` surrounding context
    const changeIndices = [];
    for (let idx = 0; idx < ops.length; idx++) {
        if (ops[idx].type !== " ") changeIndices.push(idx);
    }
    if (changeIndices.length === 0) {
        return { diffText: "", changedRatio: 0, hunkCount: 0, fallbackFull: false };
    }

    const hunks = [];
    let hunkStart = Math.max(0, changeIndices[0] - contextLines);
    let hunkEnd = Math.min(ops.length - 1, changeIndices[0] + contextLines);

    for (let c = 1; c < changeIndices.length; c++) {
        const nextStart = Math.max(0, changeIndices[c] - contextLines);
        const nextEnd = Math.min(ops.length - 1, changeIndices[c] + contextLines);
        if (nextStart <= hunkEnd + 1) {
            hunkEnd = Math.max(hunkEnd, nextEnd);
        } else {
            hunks.push([hunkStart, hunkEnd]);
            hunkStart = nextStart;
            hunkEnd = nextEnd;
        }
    }
    hunks.push([hunkStart, hunkEnd]);

    const cleanLabel = String(label || "file").replace(/\\/g, "/");
    const outLines = [`--- a/${cleanLabel}`, `+++ b/${cleanLabel}`];

    for (const [startIdx, endIdx] of hunks) {
        const slice = ops.slice(startIdx, endIdx + 1);
        const oldCount = slice.filter((op) => op.type !== "+").length;
        const newCount = slice.filter((op) => op.type !== "-").length;
        const firstOld = slice.find((op) => op.type !== "+");
        const firstNew = slice.find((op) => op.type !== "-");
        const oldStart = oldCount === 0 ? Math.max(0, (slice[0]?.oldLine || 1) - 1) : firstOld.oldLine;
        const newStart = newCount === 0 ? Math.max(0, (slice[0]?.newLine || 1) - 1) : firstNew.newLine;

        outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const op of slice) {
            outLines.push(`${op.type}${op.text}`);
        }
    }

    const diffText = outLines.join("\n");
    const changedRatio = Number((diffText.length / Math.max(1, newNorm.length)).toFixed(4));
    return {
        diffText,
        changedRatio,
        hunkCount: hunks.length,
        fallbackFull: false
    };
}

function findNormalizedLineMatches(contentNorm, searchNorm) {
    const contentLines = contentNorm.split("\n");
    const searchLines = searchNorm.split("\n");
    if (searchLines.length === 0 || (searchLines.length === 1 && searchLines[0] === "")) {
        return [];
    }
    const matches = [];
    const maxStart = contentLines.length - searchLines.length;
    for (let i = 0; i <= maxStart; i++) {
        let matched = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (contentLines[i + j].trim() !== searchLines[j].trim()) {
                matched = false;
                break;
            }
        }
        if (matched) {
            matches.push({ startLineIdx: i, lineCount: searchLines.length });
        }
    }
    return matches;
}

function applySingleSearchReplace(contentNorm, searchRaw, replaceRaw) {
    const searchNorm = String(searchRaw ?? "").replace(/\r\n/g, "\n");
    const replaceNorm = String(replaceRaw ?? "").replace(/\r\n/g, "\n");
    if (!searchNorm) {
        return { ok: false, reason: "empty SEARCH block" };
    }

    // Level 1: Exact match (must be unique)
    const firstIdx = contentNorm.indexOf(searchNorm);
    if (firstIdx !== -1) {
        const secondIdx = contentNorm.indexOf(searchNorm, firstIdx + 1);
        if (secondIdx !== -1) {
            return { ok: false, reason: "ambiguous SEARCH block (matches multiple locations)" };
        }
        const next = contentNorm.slice(0, firstIdx) + replaceNorm + contentNorm.slice(firstIdx + searchNorm.length);
        return { ok: true, content: next, mode: "exact" };
    }

    // Level 2: Indentation/whitespace-trimmed line match (must be unique)
    const normMatches = findNormalizedLineMatches(contentNorm, searchNorm);
    if (normMatches.length === 1) {
        const { startLineIdx, lineCount } = normMatches[0];
        const lines = contentNorm.split("\n");
        const replacementLines = replaceNorm === "" ? [] : replaceNorm.split("\n");
        lines.splice(startLineIdx, lineCount, ...replacementLines);
        return { ok: true, content: lines.join("\n"), mode: "whitespace_normalized" };
    }
    if (normMatches.length > 1) {
        return { ok: false, reason: `ambiguous normalized SEARCH block (${normMatches.length} matches)` };
    }
    return { ok: false, reason: "SEARCH block not found on disk" };
}

function validateDestinationPath(projectRoot, destPath) {
    if (!projectRoot || !destPath) {
        return { ok: false, reason: "missing destination path" };
    }
    let realRoot;
    try {
        realRoot = fs.realpathSync(path.resolve(projectRoot));
    } catch (_) {
        return { ok: false, reason: "invalid projectRoot" };
    }

    const resolvedDest = path.resolve(realRoot, destPath);
    // Walk up to nearest existing ancestor to resolve symlinks safely
    let ancestor = resolvedDest;
    const trailingParts = [];
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        trailingParts.unshift(path.basename(ancestor));
        ancestor = parent;
    }

    let realDest;
    try {
        const realAncestor = fs.realpathSync(ancestor);
        realDest = trailingParts.length > 0 ? path.join(realAncestor, ...trailingParts) : realAncestor;
    } catch (_) {
        realDest = resolvedDest;
    }

    const rel = path.relative(realRoot, realDest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { ok: false, reason: "destination outside projectRoot" };
    }
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (parts.slice(0, -1).some((p) => SENSITIVE_DIRS_FALLBACK.has(p.toLowerCase()))) {
        return { ok: false, reason: "sensitive destination directory" };
    }
    if (parts.length > 0 && SENSITIVE_NAME_FALLBACK.test(parts[parts.length - 1])) {
        return { ok: false, reason: "sensitive destination filename" };
    }
    return { ok: true, path: realDest };
}

/**
 * Non-destructively parses and validates `PATCH:`, `DELETE:`, and `RENAME:` directives
 * from an Orchestrator reply against the local workspace files inside `projectRoot`.
 * @param {string} replyText
 * @param {Function} resolveSafeFn - (projectRoot, filePath) => { ok, path, reason }
 * @param {string} projectRoot
 * @returns {{ ok: number, failed: number, hasOperations: boolean, details: string[] }}
 */
export function dryRunPatchBlocks(replyText, resolveSafeFn, projectRoot) {
    const text = String(replyText || "").replace(/\r\n/g, "\n");
    const lines = text.split("\n");

    const operations = [];
    let currentPatch = null;
    let inSearch = false;
    let inReplace = false;
    let searchBuf = [];
    let replaceBuf = [];

    const flushPatchTarget = () => {
        if (currentPatch && currentPatch.hunks.length > 0) {
            operations.push(currentPatch);
        }
        currentPatch = null;
        inSearch = false;
        inReplace = false;
        searchBuf = [];
        replaceBuf = [];
    };

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const trimmed = line.trim();

        if (inSearch) {
            if (trimmed === "=======") {
                inSearch = false;
                inReplace = true;
                continue;
            }
            searchBuf.push(line);
            continue;
        }

        if (inReplace) {
            if (trimmed === ">>>>>>> REPLACE") {
                if (currentPatch) {
                    currentPatch.hunks.push({
                        search: searchBuf.join("\n"),
                        replace: replaceBuf.join("\n")
                    });
                }
                inReplace = false;
                searchBuf = [];
                replaceBuf = [];
                continue;
            }
            replaceBuf.push(line);
            continue;
        }

        if (trimmed === "<<<<<<< SEARCH" && currentPatch) {
            inSearch = true;
            searchBuf = [];
            replaceBuf = [];
            continue;
        }

        const patchMatch = line.match(/^\s*PATCH:\s*(.+?)\s*$/);
        if (patchMatch) {
            flushPatchTarget();
            currentPatch = { kind: "PATCH", target: patchMatch[1].replace(/^`|`$/g, "").trim(), hunks: [] };
            continue;
        }

        const deleteMatch = line.match(/^\s*DELETE:\s*(.+?)\s*$/);
        if (deleteMatch) {
            flushPatchTarget();
            operations.push({ kind: "DELETE", target: deleteMatch[1].replace(/^`|`$/g, "").trim() });
            continue;
        }

        const renameMatch = line.match(/^\s*RENAME:\s*(.+?)\s*->\s*(.+?)\s*$/);
        if (renameMatch) {
            flushPatchTarget();
            operations.push({
                kind: "RENAME",
                from: renameMatch[1].replace(/^`|`$/g, "").trim(),
                to: renameMatch[2].replace(/^`|`$/g, "").trim()
            });
            continue;
        }

        if (/^\s*FILE:\s*.+$/.test(line)) {
            flushPatchTarget();
        }
    }
    flushPatchTarget();

    if (operations.length === 0) {
        return { ok: 0, failed: 0, hasOperations: false, details: [] };
    }

    let ok = 0;
    let failed = 0;
    const details = [];
    const workingCopies = new Map();

    const addDetail = (msg) => {
        if (details.length < 8) details.push(msg);
    };

    for (const op of operations) {
        if (op.kind === "PATCH") {
            const resolved = resolveSafeFn(projectRoot, op.target);
            if (!resolved || !resolved.ok) {
                failed += op.hunks.length;
                addDetail(`PATCH ${path.basename(op.target)}: ${resolved?.reason || "refused"}`);
                continue;
            }

            let content = workingCopies.get(resolved.path);
            if (content === undefined) {
                try {
                    content = fs.readFileSync(resolved.path, "utf8").replace(/\r\n/g, "\n");
                } catch (err) {
                    failed += op.hunks.length;
                    addDetail(`PATCH ${path.basename(op.target)}: unreadable (${err.message})`);
                    continue;
                }
            }

            for (let h = 0; h < op.hunks.length; h++) {
                const res = applySingleSearchReplace(content, op.hunks[h].search, op.hunks[h].replace);
                if (res.ok) {
                    content = res.content;
                    ok++;
                } else {
                    failed++;
                    addDetail(`PATCH ${path.basename(op.target)} hunk #${h + 1}: ${res.reason}`);
                }
            }
            workingCopies.set(resolved.path, content);
        } else if (op.kind === "DELETE") {
            const resolved = resolveSafeFn(projectRoot, op.target);
            if (resolved && resolved.ok) {
                ok++;
            } else {
                failed++;
                addDetail(`DELETE ${path.basename(op.target)}: ${resolved?.reason || "refused"}`);
            }
        } else if (op.kind === "RENAME") {
            const src = resolveSafeFn(projectRoot, op.from);
            const dst = validateDestinationPath(projectRoot, op.to);
            if (src && src.ok && dst.ok) {
                ok++;
            } else {
                failed++;
                addDetail(`RENAME ${path.basename(op.from)}: ${!src?.ok ? src?.reason || "source refused" : dst.reason}`);
            }
        }
    }

    return { ok, failed, hasOperations: true, details };
}

/**
 * Compacts verbose execution deltas (TAP / `node --test` output & Node internal stack frames)
 * when text exceeds `threshold`, preserving summaries, failing tests, assertion diffs, and
 * first-party stack frames. Non-log prose is never destructively truncated.
 * @param {string} text
 * @param {number} [threshold=3500]
 * @returns {{ text: string, compacted: boolean, savedChars: number }}
 */
export function compactExecutionDeltaText(text, threshold = 3500) {
    const raw = String(text ?? "");
    if (raw.length <= threshold) {
        return { text: raw, compacted: false, savedChars: 0 };
    }

    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let omittedPassing = 0;
    let omittedInternalFrames = 0;
    let inFailureYaml = false;

    const flushInternalFrames = () => {
        if (omittedInternalFrames > 0) {
            out.push(`    [... ${omittedInternalFrames} internal stack frame(s) omitted ...]`);
            omittedInternalFrames = 0;
        }
    };

    const flushPassing = () => {
        if (omittedPassing > 0) {
            out.push(`[... ${omittedPassing} passing test/check line(s) omitted ...]`);
            omittedPassing = 0;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (inFailureYaml) {
            if (/^\s*at\s+.*(?:node:internal\/|node_modules[\\/])/.test(line)) {
                omittedInternalFrames++;
                continue;
            }
            flushInternalFrames();
            out.push(line);
            if (trimmed === "...") {
                inFailureYaml = false;
            }
            continue;
        }

        // Preserve failing TAP / test blocks and their YAML diagnostic sections
        if (/^\s*not ok\s+\d+/i.test(line) || /^\s*[✖✗❌]\s*/.test(line)) {
            flushPassing();
            flushInternalFrames();
            out.push(line);
            if (lines[i + 1] && lines[i + 1].trim() === "---") {
                inFailureYaml = true;
            }
            continue;
        }

        // Drop verbose passing lines (TAP ok / checkmarks / doctor PASS / passing subtest headers)
        if (
            /^\s*ok\s+\d+\s+-/.test(line) ||
            /^\s*(?:✔|✓|✅\s*\[PASS\])\s+/.test(line) ||
            /^\s*#\s*Subtest:\s+/.test(line) && lines[i + 1] && /^\s*ok\s+\d+/.test(lines[i + 1])
        ) {
            omittedPassing++;
            continue;
        }

        // Drop internal Node / node_modules stack frames outside YAML blocks too
        if (/^\s*at\s+.*(?:node:internal\/|node_modules[\\/])/.test(line)) {
            omittedInternalFrames++;
            continue;
        }

        flushPassing();
        flushInternalFrames();
        out.push(line);
    }

    flushPassing();
    flushInternalFrames();

    const compactedText = out.join("\n").replace(/\n{3,}/g, "\n\n");
    const savedChars = raw.length - compactedText.length;
    if (savedChars <= 0) {
        return { text: raw, compacted: false, savedChars: 0 };
    }
    return {
        text: compactedText,
        compacted: true,
        savedChars
    };
}
