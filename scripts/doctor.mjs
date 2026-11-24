import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { toSafeAttachmentName, ALLOWED_ORIGINS, PORT } from "../extension/bridge.mjs";
import { MCP_INSTRUCTIONS } from "../extension/protocol.mjs";
import { buildCompactAttachmentHeader } from "../extension/patch-delta.mjs";
import { DEFAULT_WS_PORT, resolveBridgePort } from "../extension/session-auth.mjs";

const require = createRequire(import.meta.url);
const contentCore = require("../extension/content-core.js");
const popupMod = require("../extension/popup.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const CANONICAL_DEFAULT_PORT = 4545;

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✅ [PASS] ${message}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${message}`);
        failed++;
    }
}

console.log("=== WebAI Bridge - Diagnostic Doctor ===\n");

// 1. Verify required core & modular files exist
const requiredFiles = [
    "extension/bridge.mjs",
    "extension/protocol.mjs",
    "extension/session-auth.mjs",
    "extension/response-buffer.mjs",
    "extension/patch-delta.mjs",
    "extension/content-providers.js",
    "extension/content-upload.js",
    "extension/content-core.js",
    "extension/content.js",
    "extension/manifest.json",
    "extension/popup.html",
    "extension/popup.js",
    "package.json"
];

for (const rel of requiredFiles) {
    const full = path.join(rootDir, rel);
    assert(fs.existsSync(full), `Required file exists: ${rel}`);
}

// 2. Verify Manifest V3 integrity & modular content_scripts order
try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "extension/manifest.json"), "utf8"));
    assert(manifest.manifest_version === 3, "manifest.json is Manifest V3");
    const scripts = manifest.content_scripts?.[0]?.js || [];
    const expectedOrder = ["content-providers.js", "content-upload.js", "content-core.js", "content.js"];
    assert(
        JSON.stringify(scripts) === JSON.stringify(expectedOrder),
        `manifest.json loads modular content scripts in order (${scripts.join(" -> ")})`
    );
} catch (e) {
    assert(false, `manifest.json is valid JSON: ${e.message}`);
}

// 3. Verify canonical default port (4545) consistency across server, extension, and popup
const hasExplicitPortOverride = Boolean(
    process.env.WEBAI_BRIDGE_PORT ||
    process.env.ANTIGRAVITY_BRIDGE_PORT ||
    process.env.BRIDGE_PORT ||
    process.argv.some((arg) => arg === "--port" || arg.startsWith("--port="))
);
assert(
    DEFAULT_WS_PORT === CANONICAL_DEFAULT_PORT && resolveBridgePort({ argv: [], env: {} }) === CANONICAL_DEFAULT_PORT,
    `session-auth.mjs DEFAULT_WS_PORT is canonical (${DEFAULT_WS_PORT})`
);
assert(
    hasExplicitPortOverride ? PORT === resolveBridgePort() : PORT === CANONICAL_DEFAULT_PORT,
    `bridge.mjs PORT matches canonical/configured port (${PORT})`
);
assert(
    contentCore.DEFAULT_BRIDGE_PORT === CANONICAL_DEFAULT_PORT,
    `content-core.js DEFAULT_BRIDGE_PORT is canonical (${contentCore.DEFAULT_BRIDGE_PORT})`
);
assert(
    popupMod.DEFAULT_PORT === CANONICAL_DEFAULT_PORT,
    `popup.js DEFAULT_PORT is canonical (${popupMod.DEFAULT_PORT})`
);
const popupHtml = fs.readFileSync(path.join(rootDir, "extension/popup.html"), "utf8");
assert(
    popupHtml.includes('id="portInput"') && popupHtml.includes('value="4545"') && !popupHtml.includes("8765"),
    "popup.html default port input is canonical (4545) with no stale 8765 references"
);
assert(ALLOWED_ORIGINS.has("https://gemini.google.com"), "bridge.mjs ALLOWED_ORIGINS configured");

// 4. Verify attachment filename sanitizer
const sampleMjs = toSafeAttachmentName("c:\\repo", "c:\\repo\\extension\\bridge.mjs", 0);
assert(sampleMjs.endsWith(".txt"), `Non-standard extension (.mjs) safely suffixed with .txt -> ${sampleMjs}`);

const sampleJs = toSafeAttachmentName("c:\\repo", "c:\\repo\\extension\\content.js", 1);
assert(sampleJs.endsWith(".js"), `Standard extension (.js) preserved -> ${sampleJs}`);

const samplePng = toSafeAttachmentName("c:\\repo", "c:\\repo\\assets\\logo.png", 2);
assert(samplePng.endsWith(".png"), `Binary image extension (.png) preserved -> ${samplePng}`);

// 5. Verify zero truncation, closed-loop protocol & compact attachment headers
const bridgeSource = fs.readFileSync(path.join(rootDir, "extension/bridge.mjs"), "utf8");
assert(!bridgeSource.includes("File truncated by bridge"), "bridge.mjs has NO destructive file truncation");
assert(bridgeSource.includes("attachments.push"), "bridge.mjs builds structured native file attachments");
assert(bridgeSource.includes("buildCompactAttachmentHeader"), "bridge.mjs uses compact single-line attachment headers");
const sampleHeader = buildCompactAttachmentHeader("src/app.js", "c:\\repo\\src\\app.js");
assert(
    sampleHeader === "// FILE: src/app.js | c:\\repo\\src\\app.js",
    `patch-delta.mjs produces compact single-line header -> ${sampleHeader}`
);
assert(
    MCP_INSTRUCTIONS.includes("loop=continue") && MCP_INSTRUCTIONS.includes("PATCH:"),
    "protocol.mjs MCP_INSTRUCTIONS enforces closed-loop (loop=continue) and PATCH: contract"
);

// 6. Verify native upload vectors in content.js
const contentSource = fs.readFileSync(path.join(rootDir, "extension/content.js"), "utf8");
assert(contentSource.includes("uploadAttachmentsToDOM"), "content.js implements uploadAttachmentsToDOM");
assert(contentSource.includes("new DataTransfer()"), "content.js uses native DataTransfer & File API");
assert(contentSource.includes("ClipboardEvent('paste'"), "content.js supports ClipboardEvent('paste') vector");

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
    process.exit(1);
}
