import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MCP_INSTRUCTIONS, LEGACY_RULE, RULE_BEGIN, RULE_END, ERROR_CODES,
    OUTPUT_MODES, CONTEXT_MODES, FILE_MODES,
    estimateTokens, hasTaskCompleteSignal, resolveOutputMode, buildTurnHeader,
    bridgeError, classifyTabFailure, codeFromError, codedError, buildEnvelope,
    buildOrchestratorFooter, getToolDefinitions, resolveToolName, validateConsultArgs,
    buildStatus, detectRuleState, installRule, uninstallRule, ruleFilePath
} from "../extension/protocol.mjs";

test("tool list exposes canonical tools by default and legacy aliases only when opted in", () => {
    assert.deepEqual(
        getToolDefinitions().map(t => t.name),
        ["consult_orchestrator", "orchestrator_status"]
    );
    const withLegacy = getToolDefinitions({ includeLegacy: true }).map(t => t.name);
    assert.deepEqual(withLegacy.slice(0, 2), ["consult_orchestrator", "orchestrator_status"]);
    assert.deepEqual(withLegacy.slice(2), ["consult_web_architect", "consult_gemini_web_pro", "get_bridge_status"]);
});

test("every legacy tool name resolves to its canonical tool", () => {
    assert.deepEqual(resolveToolName("consult_gemini_web_pro"), { kind: "consult", legacy: true, canonical: "consult_orchestrator" });
    assert.deepEqual(resolveToolName("get_bridge_status"), { kind: "status", legacy: true, canonical: "orchestrator_status" });
    assert.equal(resolveToolName("consult_orchestrator").legacy, false);
    assert.equal(resolveToolName("nope"), null);
});

test("consult schema requires projectRoot and documents Tier 1/2 mode parameters", () => {
    const consult = getToolDefinitions()[0];
    assert.ok(consult.inputSchema.required.includes("projectRoot"));
    assert.deepEqual(consult.inputSchema.properties.response_type.enum, ["code_changes", "analysis"]);
    assert.deepEqual(consult.inputSchema.properties.output_mode.enum, OUTPUT_MODES);
    assert.deepEqual(consult.inputSchema.properties.context_mode.enum, CONTEXT_MODES);
    assert.deepEqual(consult.inputSchema.properties.file_mode.enum, FILE_MODES);
    assert.ok(consult.inputSchema.properties.target_files);
    assert.ok(consult.inputSchema.properties.max_context_chars);
    assert.ok(consult.description.length < 400);
});

test("validateConsultArgs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-args-"));
    try {
        assert.equal(validateConsultArgs({ projectRoot: root, task: "x", filePaths: [] }), null);
        assert.equal(validateConsultArgs({
            projectRoot: root,
            task: "x",
            filePaths: ["a.js:1-10"],
            output_mode: "patch",
            context_mode: "minimal",
            file_mode: "diff",
            target_files: ["a.js"],
            max_context_chars: 12000
        }), null);
        assert.match(validateConsultArgs({ projectRoot: "relative/dir", task: "x" }), /absolute/);
        assert.match(validateConsultArgs({ projectRoot: path.join(root, "missing"), task: "x" }), /does not exist/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "  " }), /task is required/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", filePaths: "a.js" }), /array/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", response_type: "poem" }), /response_type/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", output_mode: "yaml" }), /output_mode/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", context_mode: "huge" }), /context_mode/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", file_mode: "binary" }), /file_mode/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", target_files: "a.js" }), /target_files/);
        assert.match(validateConsultArgs({ projectRoot: root, task: "x", max_context_chars: -1 }), /max_context_chars/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("bridgeError returns isError with a machine-readable payload", () => {
    const r = bridgeError("NO_TAB", "no tab");
    assert.equal(r.isError, true);
    const body = JSON.parse(r.content[0].text).error;
    assert.equal(body.code, "NO_TAB");
    assert.equal(body.retryable, false);
    assert.match(body.action, /floating button/);
    assert.equal(JSON.parse(bridgeError("WHATEVER", "x").content[0].text).error.code, "INTERNAL");
    for (const code of ERROR_CODES) assert.ok(JSON.parse(bridgeError(code, "m").content[0].text).error.action.length > 10, code);
});

test("classifyTabFailure maps the content-script error strings", () => {
    assert.equal(classifyTabFailure("Error: Native file upload failed (no vector worked)"), "UPLOAD_FAILED");
    assert.equal(classifyTabFailure("Error: Server upload confirmation timed out"), "UPLOAD_FAILED");
    assert.equal(classifyTabFailure("Error: Generation did not start after sending"), "GENERATION_NOT_STARTED");
    assert.equal(classifyTabFailure("Error: Generation timed out after 600s"), "TIMEOUT");
    assert.equal(classifyTabFailure("Error: Input box not found"), "NO_INPUT");
    assert.equal(classifyTabFailure("Here is the fix. Error: handling changed"), null);
    assert.equal(classifyTabFailure("FILE: c:\\x.js"), null);
});

test("codeFromError prefers explicit codes and falls back on messages", () => {
    assert.equal(codeFromError(codedError("TIMEOUT", "x")), "TIMEOUT");
    assert.equal(codeFromError(new Error("Browser tab disconnected before completing")), "TAB_DISCONNECTED");
    assert.equal(codeFromError(new Error("boom")), "INTERNAL");
});

test("envelope header, telemetry, patch_check and footers", () => {
    const head = buildEnvelope({
        provider: "Google AI Studio",
        responseType: "code_changes",
        outputMode: "auto",
        filesSent: 2,
        filesDiff: 1,
        filesUnchanged: 1,
        refused: ["a (outside projectRoot)"],
        loop: "continue",
        inTokens: 500,
        outTokens: 120,
        savedTokens: 900,
        elapsedMs: 1450,
        patchCheck: { ok: 2, failed: 0, details: [] }
    });
    assert.equal(
        head.split("\n")[0],
        "[orchestrator protocol=1 provider=Google-AI-Studio status=ok response_type=code_changes mode=auto files_sent=2 files_diff=1 files_unchanged=1 files_refused=1 loop=continue in_tok=500 out_tok=120 saved_tok=900 ms=1450]"
    );
    assert.match(head, /\[refused\] a \(outside projectRoot\)/);
    assert.match(head, /\[patch_check ok=2 failed=0\]/);
    assert.match(head, /\[loop=continue\]/);

    const patchFooter = buildOrchestratorFooter("auto", { isFirstTurn: true });
    assert.match(patchFooter, /PATCH: <absolute path>/);
    assert.match(patchFooter, /```patch/);
    assert.match(patchFooter, /FILE: <absolute path>/);
    assert.match(buildOrchestratorFooter("auto", { isFirstTurn: false }), /```patch/);
    assert.doesNotMatch(buildOrchestratorFooter("analysis"), /FILE:|PATCH:/);

    assert.equal(resolveOutputMode({ response_type: "analysis" }), "analysis");
    assert.equal(resolveOutputMode({ output_mode: "patch", response_type: "code_changes" }), "patch");
    assert.match(buildTurnHeader({ isFirstTurn: true, outputMode: "auto" }), /<role>/);
    assert.match(buildTurnHeader({ isFirstTurn: false, outputMode: "auto" }), /follow-up/);
});

test("hasTaskCompleteSignal and estimateTokens", () => {
    assert.equal(hasTaskCompleteSignal("All verified.\n\nTASK_COMPLETE"), true);
    assert.equal(hasTaskCompleteSignal("Done.\n**TASK_COMPLETE**\n"), true);
    assert.equal(hasTaskCompleteSignal("Done.\n`TASK_COMPLETE`"), true);
    assert.equal(hasTaskCompleteSignal("Do not emit TASK_COMPLETE yet."), false);
    assert.equal(hasTaskCompleteSignal("Example:\n```\nTASK_COMPLETE\n```\nStill working."), false);
    assert.equal(hasTaskCompleteSignal("~~~\nTASK_COMPLETE\n~~~"), false);
    assert.equal(hasTaskCompleteSignal(""), false);

    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("12345"), 2);
});

test("status tells a disconnected agent what to do", () => {
    const s = buildStatus({ connected: false, port: 4545, version: "x" });
    assert.equal(s.connected, false);
    assert.match(s.next_action, /floating button/);
    assert.equal(buildStatus({ connected: true, port: 4545, version: "x", session: { provider: "Claude" } }).provider, "Claude");
});

test("instructions cover roles, errors and the no-code case", () => {
    for (const needle of ["EXECUTOR", "ORCHESTRATOR", "consult_orchestrator", "orchestrator_status", "NO_TAB", "response_type", "untrusted", "No code"]) {
        assert.ok(MCP_INSTRUCTIONS.includes(needle), needle);
    }
    for (const code of ERROR_CODES.filter(c => c !== "INTERNAL")) assert.ok(MCP_INSTRUCTIONS.includes(code), code);
});

test("rule install is opt-in, idempotent, migrates the legacy block and is reversible", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
    const file = ruleFilePath(home);
    assert.equal(detectRuleState({ home }), "none");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# My own rules\nBe nice.\n\n${LEGACY_RULE}\n\n# More rules\nUse tabs.\n`);
    assert.equal(detectRuleState({ home }), "legacy");

    assert.equal(installRule({ home }).action, "updated");
    let text = fs.readFileSync(file, "utf8");
    assert.equal(detectRuleState({ home }), "managed");
    assert.ok(text.startsWith(RULE_BEGIN));
    assert.ok(text.includes(RULE_END));
    assert.ok(!text.includes("consult_gemini_web_pro"));
    assert.ok(text.includes("Be nice.") && text.includes("Use tabs."));

    assert.equal(installRule({ home }).action, "unchanged");

    assert.equal(uninstallRule({ home }).action, "removed");
    text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(RULE_BEGIN));
    assert.ok(text.includes("Be nice.") && text.includes("Use tabs."));
    assert.equal(uninstallRule({ home }).action, "absent");
});

test("installRule creates the file when missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
    assert.equal(installRule({ home }).action, "created");
    assert.equal(detectRuleState({ home }), "managed");
});
