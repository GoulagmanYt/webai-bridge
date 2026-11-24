import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, "../extension/bridge.mjs");
const PORT = 45000 + Math.floor(Math.random() * 900);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-project-"));
const samplePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
fs.writeFileSync(path.join(project, "a.js"), "console.log('a');\n");
fs.writeFileSync(path.join(project, "pixel.png"), samplePngBytes);
fs.writeFileSync(path.join(project, ".env"), "SECRET=1\n");

const tab = {
    ws: null,
    prompts: [],
    reply: "OK reply",
    isEmptyChat: false,
    closeOnPrompt: false,
    delayMs: 0,
    domDiagnostic: { lastResponseFull: "", lastResponseSnippet: "" }
};

function makeBridgeEnv(port, homeDir) {
    return {
        ...process.env,
        WEBAI_BRIDGE_PORT: "",
        ANTIGRAVITY_BRIDGE_PORT: "",
        BRIDGE_PORT: String(port),
        HOME: homeDir,
        USERPROFILE: homeDir
    };
}

async function waitForCondition(predicate, timeoutMs = 2500, stepMs = 40) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return Boolean(predicate());
}

function connectTab() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "https://claude.ai" });
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (!msg.id) return;
            if (msg.type === "check_session") {
                ws.send(JSON.stringify({
                    id: msg.id,
                    type: msg.type,
                    payload: {
                        provider: "Claude",
                        isEmptyChat: tab.isEmptyChat,
                        chatKey: "https://claude.ai/chat/1",
                        busy: false,
                        activeRequestId: null,
                        uploadState: "IDLE",
                        domDiagnostic: tab.domDiagnostic
                    }
                }));
            } else if (msg.type === "inspect_tab") {
                ws.send(JSON.stringify({
                    id: msg.id,
                    type: "inspect_tab_response",
                    payload: {
                        provider: { id: "claude", name: "Anthropic Claude" },
                        tab: { url: "https://claude.ai/chat/1", isBusy: false },
                        input: { found: true, tag: "div" },
                        sendButton: { found: true, disabled: false },
                        debugLogs: [{ category: "SYSTEM", level: "info", message: "mock ready" }]
                    }
                }));
            } else if (msg.type === "prompt") {
                tab.prompts.push(msg.payload || msg);
                if (tab.closeOnPrompt) return ws.close();
                if (tab.delayMs > 0) {
                    const jobId = msg.jobId || msg.id;
                    const finalReply = tab.reply;
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: "STREAM_CHUNK",
                                jobId,
                                requestId: jobId,
                                fullText: "Streaming partial output...",
                                chunksEmitted: 1,
                                isThinking: false
                            }));
                        }
                    }, 25);
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                id: msg.id,
                                type: "RESPONSE_COMPLETE",
                                jobId,
                                requestId: jobId,
                                text: finalReply,
                                response: finalReply,
                                chunksEmitted: 2
                            }));
                        }
                    }, tab.delayMs);
                    return;
                }
                ws.send(JSON.stringify({ id: msg.id, type: "prompt", payload: { reply: tab.reply }, reply: tab.reply }));
            }
        });
        ws.on("open", () => { tab.ws = ws; setTimeout(resolve, 150); });
        ws.on("error", reject);
    });
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    env: makeBridgeEnv(PORT, home),
    stderr: "ignore"
});
const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });

const text = (r) => r.content[0].text;
const consult = (args, name = "consult_orchestrator") => client.callTool({ name, arguments: { projectRoot: project, conversation_history_and_context: "ctx", task: "do it", filePaths: [], ...args } });

before(async () => { await client.connect(transport); });
after(async () => {
    try { tab.ws?.close(); } catch {}
    try { await client.close(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
});

test("server identifies as webai-bridge and exposes canonical tools only in listTools by default", async () => {
    assert.equal(client.getServerVersion().name, "webai-bridge");
    assert.match(client.getInstructions(), /EXECUTOR/);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.deepEqual(names, ["consult_orchestrator", "orchestrator_status"]);
});

test("without a tab: status explains how to connect, consult fails with NO_TAB", async () => {
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: {} })));
    assert.equal(status.connected, false);
    assert.match(status.next_action, /floating button/);
    const r = await consult({});
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "NO_TAB");
});

test("bad arguments fail with BAD_REQUEST before touching the tab", async () => {
    const r = await consult({ projectRoot: "relative" });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "BAD_REQUEST");
});

test("orchestrator_status with unknown jobId returns protocol_version and not_found", async () => {
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: { jobId: "job_does_not_exist" } })));
    assert.equal(status.protocol_version, "1");
    assert.equal(status.jobId, "job_does_not_exist");
    assert.equal(status.status, "not_found");
});

test("connected tab: status shows the provider and session.json is persisted on listening", async () => {
    await connectTab();
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: {} })));
    assert.equal(status.connected, true);
    assert.equal(status.provider, "Claude");

    const sessionFile = path.join(home, ".webai-bridge", "session.json");
    assert.equal(fs.existsSync(sessionFile), true);
    const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.equal(sessionData.port, PORT);
    assert.ok(typeof sessionData.sessionId === "string" && sessionData.sessionId.startsWith("sess_"));
    assert.ok(typeof sessionData.token === "string" && sessionData.token.length === 64);
});

test("orchestrator_status with inspect=true returns protocol_version and live diagnostics", async () => {
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: { inspect: true, includeLogs: true } })));
    assert.equal(status.protocol_version, "1");
    assert.equal(status.connected, true);
    assert.equal(status.provider, "Anthropic Claude");
    assert.equal(status.diagnostics.input.found, true);
    assert.equal(status.diagnostics.debugLogs.length, 1);
});

test("get_last_response on empty cache/chat returns BAD_REQUEST without dispatching a prompt", async () => {
    const beforeCount = tab.prompts.length;
    const r = await consult({ task: "get_last_response" });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "BAD_REQUEST");
    assert.equal(tab.prompts.length, beforeCount);
});

test("consult: envelope, telemetry, safe attachments, refusals reported, XML role and PATCH/FILE footer sent", async () => {
    const r = await consult({ filePaths: ["a.js", ".env", "../outside.txt"] });
    assert.notEqual(r.isError, true);
    const out = text(r);
    const head = out.split("\n")[0];
    assert.match(head, /^\[orchestrator protocol=1 provider=Claude status=ok response_type=code_changes mode=auto files_sent=1 files_unchanged=0 files_refused=2 loop=continue in_tok=\d+ out_tok=\d+ .*ms=\d+\]$/);
    assert.match(out, /\[refused\] \.env \(sensitive file/);
    assert.match(out, /\[refused\] \.\.\/outside\.txt/);
    assert.match(out, /\[loop=continue\]/);
    assert.ok(out.endsWith("OK reply"));

    const sent = tab.prompts.at(-1);
    assert.match(sent.prompt, /<role>/);
    assert.match(sent.prompt, /PATCH: <absolute path>/);
    assert.match(sent.prompt, /FILE: <absolute path>/);
    assert.ok(sent.attachments.some(a => a.originalPath.endsWith("a.js")));
    assert.ok(!sent.attachments.some(a => /\.env$/.test(a.originalPath)));
    assert.match(sent.prompt, /\[REFUSED: sensitive file/);
});

test("get_last_response returns cached reply without dispatching a new prompt", async () => {
    const beforeCount = tab.prompts.length;
    const r = await consult({ task: "get_last_response" });
    assert.notEqual(r.isError, true);
    assert.ok(text(r).endsWith("OK reply"));
    assert.equal(tab.prompts.length, beforeCount);
});

test("consult attaches binary .png files as base64 without text header corruption", async () => {
    const r = await consult({ task: "inspect image", filePaths: ["pixel.png"] });
    assert.notEqual(r.isError, true);
    const sent = tab.prompts.at(-1);
    const pngAtt = sent.attachments.find(a => a.originalPath.endsWith("pixel.png"));
    assert.ok(pngAtt, "pixel.png attachment should be present");
    assert.equal(pngAtt.encoding, "base64");
    assert.equal(pngAtt.mimeType, "image/png");
    assert.ok(pngAtt.name.endsWith(".png"));
    assert.deepEqual(Buffer.from(pngAtt.content, "base64"), samplePngBytes);
    assert.match(sent.prompt, /ATTACHED BINARY FILE:/);
});

test("follow-up in the same chat is a compact delta and unchanged files are not resent", async () => {
    const r = await consult({ filePaths: ["a.js"] });
    assert.match(text(r).split("\n")[0], /files_sent=0 files_unchanged=1 files_refused=0/);
    assert.match(tab.prompts.at(-1).prompt, /follow-up/);
    assert.match(tab.prompts.at(-1).prompt, /\[UNCHANGED\]/);
});

test("response_type analysis asks for prose, not files", async () => {
    const r = await consult({ response_type: "analysis" });
    assert.match(text(r).split("\n")[0], /response_type=analysis mode=analysis/);
    assert.match(tab.prompts.at(-1).prompt, /Prose only/);
    assert.doesNotMatch(tab.prompts.at(-1).prompt, /FILE: <absolute path>/);
});

test("orchestrator_status({ jobId }) tracks in-flight streaming and completed jobs", async () => {
    tab.delayMs = 350;
    tab.reply = "Slow completed reply";
    try {
        const partialRes = await consult({ task: "slow generation", softTimeoutMs: 90 });
        assert.notEqual(partialRes.isError, true);
        const partialOut = text(partialRes);
        assert.match(partialOut, /status=partial_streaming/);
        const match = partialOut.match(/jobId=([^\s\]]+)/);
        assert.ok(match, "partial_streaming header should contain jobId");
        const jobId = match[1];

        const midStatus = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: { jobId } })));
        assert.equal(midStatus.protocol_version, "1");
        assert.equal(midStatus.jobId, jobId);
        assert.ok(["pending", "streaming", "completed"].includes(midStatus.status));

        const resumed = await consult({ jobId, softTimeoutMs: 2000 });
        assert.notEqual(resumed.isError, true);
        assert.ok(text(resumed).endsWith("Slow completed reply"));

        const doneStatus = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: { jobId } })));
        assert.equal(doneStatus.protocol_version, "1");
        assert.equal(doneStatus.status, "completed");
        assert.equal(doneStatus.text, "Slow completed reply");
    } finally {
        tab.delayMs = 0;
        tab.reply = "OK reply";
    }
});

test("legacy tool names keep working", async () => {
    const r = await consult({}, "consult_gemini_web_pro");
    assert.notEqual(r.isError, true);
    assert.match(text(r), /^\[orchestrator /);
});

test("an upload failure becomes UPLOAD_FAILED and forces a full resend next time", async () => {
    tab.reply = "Error: Native file upload failed (no vector worked)";
    const failed = await consult({ filePaths: ["a.js"] });
    assert.equal(failed.isError, true);
    const body = JSON.parse(text(failed)).error;
    assert.equal(body.code, "UPLOAD_FAILED");
    assert.equal(body.retryable, true);

    tab.reply = "OK again";
    const retry = await consult({ filePaths: ["a.js"] });
    assert.notEqual(retry.isError, true);
    assert.match(tab.prompts.at(-1).prompt, /\[SESSION BRIEFING\]/);
    assert.match(tab.prompts.at(-1).prompt, /<role>/);
    assert.match(text(retry).split("\n")[0], /files_sent=1/);
});

test("line slices (path:start-end) and incremental diffs (file_mode=diff) save tokens", async () => {
    const lines = Array.from({ length: 24 }, (_, idx) => `export const line_${idx + 1} = ${idx + 1};`);
    const multiPath = path.join(project, "multi.js");
    fs.writeFileSync(multiPath, lines.join("\n") + "\n");

    const sliceRes = await consult({ task: "inspect lines", filePaths: ["multi.js:2-4"] });
    assert.notEqual(sliceRes.isError, true);
    const sliceSent = tab.prompts.at(-1);
    const sliceAtt = sliceSent.attachments.find(a => a.originalPath.endsWith("multi.js"));
    assert.ok(sliceAtt && sliceAtt.content.includes("2| export const line_2 = 2;"));
    assert.match(sliceSent.prompt, /ATTACHED SLICE:/);

    const fullRes = await consult({ task: "seed snapshot", filePaths: ["multi.js"] });
    assert.notEqual(fullRes.isError, true);

    lines[9] = "export const line_10 = 999;";
    fs.writeFileSync(multiPath, lines.join("\n") + "\n");

    const diffRes = await consult({ task: "review small edit", filePaths: ["multi.js"], file_mode: "diff" });
    assert.notEqual(diffRes.isError, true);
    assert.match(text(diffRes).split("\n")[0], /files_diff=1/);
    assert.match(text(diffRes).split("\n")[0], /saved_tok=\d+/);
    const diffSent = tab.prompts.at(-1);
    const diffAtt = diffSent.attachments.find(a => a.originalPath.endsWith("multi.js"));
    assert.ok(diffAtt && diffAtt.name.endsWith(".diff.txt"));
    assert.match(diffAtt.content, /@@ /);
    assert.match(diffAtt.content, /\+export const line_10 = 999;/);
});

test("PATCH dry-run validation reports ok/failed hunks and loop=complete tracks standalone TASK_COMPLETE", async () => {
    const aAbs = path.join(project, "a.js");
    tab.reply = [
        `PATCH: ${aAbs}`,
        "```patch",
        "<<<<<<< SEARCH",
        "console.log('a');",
        "=======",
        "console.log('a_updated');",
        ">>>>>>> REPLACE",
        "```",
        "",
        "TASK_COMPLETE"
    ].join("\n");

    const okPatch = await consult({ task: "apply patch" });
    const okOut = text(okPatch);
    assert.match(okOut.split("\n")[0], /loop=complete/);
    assert.match(okOut, /\[patch_check ok=1 failed=0\]/);
    assert.doesNotMatch(okOut, /\[loop=continue\]/);

    tab.reply = [
        `PATCH: ${aAbs}`,
        "```patch",
        "<<<<<<< SEARCH",
        "nonexistent_line_that_will_fail();",
        "=======",
        "replacement();",
        ">>>>>>> REPLACE",
        "```"
    ].join("\n");

    const badPatch = await consult({ task: "bad patch" });
    const badOut = text(badPatch);
    assert.match(badOut.split("\n")[0], /loop=continue/);
    assert.match(badOut, /\[patch_check ok=0 failed=1/);
    tab.reply = "OK reply";
});

test("orchestrator_status exposes cumulative sessionMetrics", async () => {
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: {} })));
    assert.ok(status.sessionMetrics);
    assert.ok(status.sessionMetrics.turns >= 1);
    assert.ok(status.sessionMetrics.inTokens > 0);
    assert.ok(status.sessionMetrics.outTokens > 0);
    assert.ok(status.sessionMetrics.diffsSent >= 1);
    assert.ok(status.sessionMetrics.slicesSent >= 1);
});

test("a tab that disconnects mid-request yields TAB_DISCONNECTED", async () => {
    tab.closeOnPrompt = true;
    const r = await consult({});
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "TAB_DISCONNECTED");
});

test("session.json is removed on clean shutdown only when owned by that bridge instance", async () => {
    const ownHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-own-"));
    const foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-foreign-"));
    const portOwn = 46000 + Math.floor(Math.random() * 400);
    const portForeign = 46500 + Math.floor(Math.random() * 400);

    try {
        // 1. Owned session file is created on listening and cleaned up on close
        const t1 = new StdioClientTransport({
            command: process.execPath,
            args: [bridgePath],
            env: makeBridgeEnv(portOwn, ownHome),
            stderr: "ignore"
        });
        const c1 = new Client({ name: "e2e-own", version: "1.0.0" }, { capabilities: {} });
        await c1.connect(t1);
        const ownFile = path.join(ownHome, ".webai-bridge", "session.json");
        assert.equal(await waitForCondition(() => fs.existsSync(ownFile)), true, "owned session.json should be written");
        await c1.close();
        assert.equal(await waitForCondition(() => !fs.existsSync(ownFile)), true, "owned session.json should be deleted on close");

        // 2. Foreign session file is NOT deleted when another bridge shuts down
        const t2 = new StdioClientTransport({
            command: process.execPath,
            args: [bridgePath],
            env: makeBridgeEnv(portForeign, foreignHome),
            stderr: "ignore"
        });
        const c2 = new Client({ name: "e2e-foreign", version: "1.0.0" }, { capabilities: {} });
        await c2.connect(t2);
        const foreignFile = path.join(foreignHome, ".webai-bridge", "session.json");
        assert.equal(await waitForCondition(() => fs.existsSync(foreignFile)), true, "initial session.json should be written");

        const foreignPayload = { sessionId: "sess_other_active_bridge", port: 49999, pid: 999999 };
        fs.writeFileSync(foreignFile, JSON.stringify(foreignPayload, null, 2), "utf8");
        await c2.close();
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(fs.existsSync(foreignFile), true, "foreign session.json must remain intact after close");
        assert.equal(JSON.parse(fs.readFileSync(foreignFile, "utf8")).sessionId, "sess_other_active_bridge");
    } finally {
        fs.rmSync(ownHome, { recursive: true, force: true });
        fs.rmSync(foreignHome, { recursive: true, force: true });
    }
});
