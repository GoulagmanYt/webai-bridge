import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    resolveSafeFile,
    isSensitiveRelPath,
    parseListeningPid,
    withTabLock,
    readAttachmentFile,
    isProcessAlive,
    startParentWatchdog,
    isMainModule
} from "../extension/bridge.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-safety-"));
const root = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.mkdirSync(path.join(root, ".git"), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "src", "app.js"), "ok");
fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
fs.writeFileSync(path.join(root, ".git", "config"), "x");
fs.writeFileSync(path.join(outside, "id_rsa"), "KEY");
fs.writeFileSync(path.join(outside, "notes.txt"), "n");

const samplePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const samplePdfBytes = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n\x00binary-pdf", "latin1");
const sampleNullBytes = Buffer.from([0x41, 0x42, 0x00, 0x43, 0xff]);
fs.writeFileSync(path.join(root, "assets", "icon.png"), samplePngBytes);
fs.writeFileSync(path.join(root, "assets", "spec.pdf"), samplePdfBytes);
fs.writeFileSync(path.join(root, "assets", "blob.dat"), sampleNullBytes);

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("accepts a normal file inside projectRoot (absolute and relative)", () => {
    assert.equal(resolveSafeFile(root, path.join(root, "src", "app.js")).ok, true);
    assert.equal(resolveSafeFile(root, "src/app.js").ok, true);
});

test("refuses paths outside projectRoot, including traversal", () => {
    assert.equal(resolveSafeFile(root, path.join(outside, "notes.txt")).reason, "outside projectRoot");
    assert.equal(resolveSafeFile(root, "../outside/notes.txt").reason, "outside projectRoot");
});

test("refuses credentials and VCS internals inside the project", () => {
    assert.equal(resolveSafeFile(root, ".env").ok, false);
    assert.equal(resolveSafeFile(root, ".git/config").ok, false);
});

test("refuses a symlink that escapes projectRoot", (t) => {
    const link = path.join(root, "src", "link.txt");
    try { fs.symlinkSync(path.join(outside, "notes.txt"), link); } catch { return t.skip("symlinks not permitted"); }
    assert.equal(resolveSafeFile(root, "src/link.txt").reason, "outside projectRoot");
});

test("reports missing files and honours BRIDGE_EXTRA_ROOTS", () => {
    assert.equal(resolveSafeFile(root, "nope.js").reason, "file not found");
    process.env.BRIDGE_EXTRA_ROOTS = outside;
    try {
        assert.equal(resolveSafeFile(root, path.join(outside, "notes.txt")).ok, true);
        assert.equal(resolveSafeFile(root, path.join(outside, "id_rsa")).ok, false);
    } finally {
        delete process.env.BRIDGE_EXTRA_ROOTS;
    }
});

test("isSensitiveRelPath", () => {
    for (const p of [".env", ".env.local", "a/b/server.pem", "id_ed25519", ".ssh/config", "x/.aws/credentials", "secrets.yml"]) {
        assert.equal(isSensitiveRelPath(p), true, p);
    }
    for (const p of ["src/app.js", "README.md", "environment.md", "keyboard.js"]) {
        assert.equal(isSensitiveRelPath(p), false, p);
    }
});

test("parseListeningPid is exact on the port and locale independent", () => {
    const out = [
        "  Proto  Adresse locale          Adresse distante        État           PID",
        "  TCP    127.0.0.1:45450        0.0.0.0:0               LISTENING       111",
        "  TCP    127.0.0.1:4545         0.0.0.0:0               ÉCOUTE          222",
        "  TCP    127.0.0.1:4545         127.0.0.1:50000         ESTABLISHED     333"
    ].join("\r\n");
    assert.equal(parseListeningPid(out, 4545, 1), "222");
    assert.equal(parseListeningPid(out, 4545, 222), null);
    assert.equal(parseListeningPid(out, 9999, 1), null);
});

test("withTabLock runs tasks strictly one at a time, even after a failure", async () => {
    const order = [];
    const job = (name, ms, fail) => withTabLock(async () => {
        order.push(`start:${name}`);
        await new Promise(r => setTimeout(r, ms));
        order.push(`end:${name}`);
        if (fail) throw new Error(name);
    });
    const results = await Promise.allSettled([job("a", 30, true), job("b", 5), job("c", 5)]);
    assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[2].status, "fulfilled");
});

test("readAttachmentFile encodes UTF-8 text with header and binary PNG/PDF/NUL files as base64 without text header", () => {
    const textPrepared = readAttachmentFile(root, path.join(root, "src", "app.js"), 0);
    assert.equal(textPrepared.isBinary, false);
    assert.equal(textPrepared.attachment.encoding, "utf8");
    assert.equal(textPrepared.attachment.mimeType, "text/plain");
    assert.match(textPrepared.attachment.content, /^\/\/ FILE: src\/app\.js \|/);
    assert.ok(textPrepared.attachment.content.endsWith("ok"));
    assert.match(textPrepared.manifestLine, /ATTACHED FILE:/);

    const pngPrepared = readAttachmentFile(root, path.join(root, "assets", "icon.png"), 1);
    assert.equal(pngPrepared.isBinary, true);
    assert.equal(pngPrepared.attachment.encoding, "base64");
    assert.equal(pngPrepared.attachment.mimeType, "image/png");
    assert.ok(pngPrepared.attachment.name.endsWith(".png"));
    assert.doesNotMatch(pngPrepared.attachment.content, /^\/\/ FILE:/);
    assert.deepEqual(Buffer.from(pngPrepared.attachment.content, "base64"), samplePngBytes);
    assert.match(pngPrepared.manifestLine, /ATTACHED BINARY FILE:/);

    const pdfPrepared = readAttachmentFile(root, path.join(root, "assets", "spec.pdf"), 2);
    assert.equal(pdfPrepared.isBinary, true);
    assert.equal(pdfPrepared.attachment.encoding, "base64");
    assert.equal(pdfPrepared.attachment.mimeType, "application/pdf");
    assert.ok(pdfPrepared.attachment.name.endsWith(".pdf"));
    assert.deepEqual(Buffer.from(pdfPrepared.attachment.content, "base64"), samplePdfBytes);

    const blobPrepared = readAttachmentFile(root, path.join(root, "assets", "blob.dat"), 3);
    assert.equal(blobPrepared.isBinary, true);
    assert.equal(blobPrepared.attachment.encoding, "base64");
    assert.equal(blobPrepared.attachment.mimeType, "application/octet-stream");
    assert.ok(blobPrepared.attachment.name.endsWith(".txt"));
    assert.deepEqual(Buffer.from(blobPrepared.attachment.content, "base64"), sampleNullBytes);
});

test("isProcessAlive, startParentWatchdog, and isMainModule guard behavior", async () => {
    assert.equal(isMainModule(), false);
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(1), true);
    assert.equal(isProcessAlive(0), true);
    assert.equal(isProcessAlive(999999999), false);

    const prevOptOut = process.env.BRIDGE_NO_WATCHDOG;
    try {
        process.env.BRIDGE_NO_WATCHDOG = "1";
        assert.equal(startParentWatchdog(() => {}, { parentPid: process.pid, intervalMs: 50 }), null);

        delete process.env.BRIDGE_NO_WATCHDOG;
        assert.equal(startParentWatchdog(() => {}, { parentPid: 1, intervalMs: 50 }), null);

        let orphanExitCode = null;
        const timer = startParentWatchdog(
            (code) => { orphanExitCode = code; },
            { parentPid: 999999999, intervalMs: 25 }
        );
        assert.ok(timer);
        try {
            await new Promise((r) => setTimeout(r, 90));
            assert.equal(orphanExitCode, 0);
        } finally {
            clearInterval(timer);
        }
    } finally {
        if (prevOptOut === undefined) delete process.env.BRIDGE_NO_WATCHDOG;
        else process.env.BRIDGE_NO_WATCHDOG = prevOptOut;
    }
});
