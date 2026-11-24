import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "../extension/patch-delta.mjs";
import { RULE_BEGIN, RULE_END } from "../extension/protocol.mjs";
import { autoDiscoverProjectContext, resolveSafeFile } from "../extension/bridge.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-patch-delta-"));
const root = path.join(tmp, "project");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, ".gemini", "skills", "webai-orchestrator"), { recursive: true });

fs.writeFileSync(
    path.join(root, "src", "demo.js"),
    "function alpha() {\n    return 1;\n}\n\nfunction beta() {\n    return 2;\n}\n"
);
fs.writeFileSync(path.join(root, "src", "obsolete.js"), "export const old = true;\n");
fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
        name: "demo-pkg",
        version: "1.0.0",
        description: "very long marketing description",
        keywords: ["a", "b"],
        scripts: { test: "node --test" },
        dependencies: { ws: "^8.23.0" }
    }, null, 2)
);
fs.writeFileSync(
    path.join(root, "GEMINI.md"),
    `${RULE_BEGIN}\nManaged bridge instructions\n${RULE_END}\n\n# Real Project Notes\nUse strict mode.\n`
);
fs.writeFileSync(
    path.join(root, ".gemini", "skills", "webai-orchestrator", "SKILL.md"),
    "# Self skill should be excluded\n"
);
fs.writeFileSync(path.join(root, ".webaiignore"), "ignored-dir/\n*.generated.md\n");
fs.writeFileSync(path.join(root, "TODO.md"), "- ship tier 2\n");

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseFileSpec handles Unix, Windows drive letters, single-line and range slices", () => {
    assert.deepEqual(parseFileSpec("src/demo.js"), { filePath: "src/demo.js", startLine: null, endLine: null, isSlice: false });
    assert.deepEqual(parseFileSpec("C:\\repo\\src\\demo.js:10-40"), { filePath: "C:\\repo\\src\\demo.js", startLine: 10, endLine: 40, isSlice: true });
    assert.deepEqual(parseFileSpec("src/demo.js:7"), { filePath: "src/demo.js", startLine: 7, endLine: 7, isSlice: true });
    assert.deepEqual(parseFileSpec("src/demo.js:25-12"), { filePath: "src/demo.js", startLine: 12, endLine: 25, isSlice: true });
    assert.deepEqual(parseFileSpec("C:123"), { filePath: "C:123", startLine: null, endLine: null, isSlice: false });
});

test("sliceTextByLines clamps bounds and formats 1-based line numbers", () => {
    const res = sliceTextByLines("a\nb\nc\nd", 2, 10);
    assert.equal(res.startLine, 2);
    assert.equal(res.endLine, 4);
    assert.equal(res.totalLines, 4);
    assert.equal(res.text, "2| b\n3| c\n4| d");
    assert.equal(sliceTextByLines("", 1, 5).text, "");
});

test("compact header, managed-block stripping, package.json trimming, and ignore rules", () => {
    assert.equal(buildCompactAttachmentHeader("src\\demo.js", "C:\\repo\\src\\demo.js"), "// FILE: src/demo.js | C:\\repo\\src\\demo.js");

    const stripped = stripManagedBridgeBlock(fs.readFileSync(path.join(root, "GEMINI.md"), "utf8"), RULE_BEGIN, RULE_END);
    assert.doesNotMatch(stripped, /Managed bridge instructions/);
    assert.match(stripped, /Real Project Notes/);

    const trimmedPkg = JSON.parse(trimPackageJsonForContext(fs.readFileSync(path.join(root, "package.json"), "utf8")));
    assert.equal(trimmedPkg.name, "demo-pkg");
    assert.equal(trimmedPkg.dependencies.ws, "^8.23.0");
    assert.equal(trimmedPkg.description, undefined);
    assert.equal(trimmedPkg.keywords, undefined);

    const patterns = parseIgnorePatterns(root, { BRIDGE_CONTEXT_EXCLUDE: "docs/archive/*,*.snap" });
    assert.equal(shouldExcludeContextRelPath("package-lock.json", patterns), true);
    assert.equal(shouldExcludeContextRelPath(".gemini/skills/webai-orchestrator/SKILL.md", patterns), true);
    assert.equal(shouldExcludeContextRelPath("ignored-dir/notes.md", patterns), true);
    assert.equal(shouldExcludeContextRelPath("api.generated.md", patterns), true);
    assert.equal(shouldExcludeContextRelPath("docs/archive/old.md", patterns), true);
    assert.equal(shouldExcludeContextRelPath("src/demo.js", patterns), false);
});

test("computeCompactUnifiedDiff emits minimal unified hunks and handles identical/large inputs", () => {
    const before = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n");
    assert.equal(computeCompactUnifiedDiff(before, before, "demo.js").hunkCount, 0);

    const afterLines = before.split("\n");
    afterLines[14] = "const v14 = 999;";
    const diff = computeCompactUnifiedDiff(before, afterLines.join("\n"), "src/demo.js");
    assert.equal(diff.fallbackFull, false);
    assert.equal(diff.hunkCount, 1);
    assert.ok(diff.changedRatio < 0.5);
    assert.match(diff.diffText, /--- a\/src\/demo\.js/);
    assert.match(diff.diffText, /\-const v14 = 14;/);
    assert.match(diff.diffText, /\+const v14 = 999;/);

    const hugeFallback = computeCompactUnifiedDiff("a\nb\nc", "x\ny\nz", "big.js", { maxMatrixCells: 2 });
    assert.equal(hugeFallback.fallbackFull, true);
});

test("dryRunPatchBlocks validates exact, whitespace-normalized, ambiguous, missing, DELETE, and RENAME ops", () => {
    const demoAbs = path.join(root, "src", "demo.js");
    const obsoleteAbs = path.join(root, "src", "obsolete.js");
    const renamedAbs = path.join(root, "src", "renamed.js");
    const outsideAbs = path.join(tmp, "escape.js");

    const okReply = [
        `PATCH: ${demoAbs}`,
        "```patch",
        "<<<<<<< SEARCH",
        "function alpha() {",
        "    return 1;",
        "}",
        "=======",
        "function alpha() {",
        "    return 10;",
        "}",
        ">>>>>>> REPLACE",
        "<<<<<<< SEARCH",
        "function beta() {",
        "  return 2;",
        "}",
        "=======",
        "function beta() {",
        "    return 20;",
        "}",
        ">>>>>>> REPLACE",
        "```",
        `DELETE: ${obsoleteAbs}`,
        `RENAME: ${demoAbs} -> ${renamedAbs}`
    ].join("\n");

    const okRes = dryRunPatchBlocks(okReply, resolveSafeFile, root);
    assert.equal(okRes.hasOperations, true);
    assert.equal(okRes.ok, 4);
    assert.equal(okRes.failed, 0);

    const failReply = [
        `PATCH: ${demoAbs}`,
        "```patch",
        "<<<<<<< SEARCH",
        "does_not_exist()",
        "=======",
        "x()",
        ">>>>>>> REPLACE",
        "```",
        `RENAME: ${demoAbs} -> ${outsideAbs}`
    ].join("\n");

    const failRes = dryRunPatchBlocks(failReply, resolveSafeFile, root);
    assert.equal(failRes.ok, 0);
    assert.equal(failRes.failed, 2);
    assert.equal(failRes.details.length, 2);
});

test("compactExecutionDeltaText strips verbose passing lines and internal stack frames while keeping failures", () => {
    const passingLines = Array.from({ length: 120 }, (_, i) => `ok ${i + 1} - passing test number ${i + 1} with long description`);
    const failureBlock = [
        "not ok 121 - failing assertion",
        "  ---",
        "  error: 'expected 1 to equal 2'",
        "  stack: |-",
        "    at TestContext.<anonymous> (file:///c:/repo/test/sample.test.mjs:12:5)",
        "    at Test.runInAsyncScope (node:async_hooks:206:9)",
        "    at Test.run (node:internal/test_runner/test:799:25)",
        "  ...",
        "# tests 121",
        "# pass 120",
        "# fail 1"
    ];
    const raw = [...passingLines, ...failureBlock].join("\n");
    const res = compactExecutionDeltaText(raw, 500);
    assert.equal(res.compacted, true);
    assert.ok(res.savedChars > 2000);
    assert.match(res.text, /not ok 121 - failing assertion/);
    assert.match(res.text, /sample\.test\.mjs:12:5/);
    assert.doesNotMatch(res.text, /node:internal\/test_runner/);
    assert.match(res.text, /# fail 1/);
});

test("autoDiscoverProjectContext enforces contextMode, excludes bridge self-rules/skills, and trims package.json", () => {
    assert.equal(autoDiscoverProjectContext(root, [], { contextMode: "none" }), "");

    const minimal = autoDiscoverProjectContext(root, [], { contextMode: "minimal" });
    assert.match(minimal, /demo-pkg/);
    assert.doesNotMatch(minimal, /very long marketing description/);
    assert.doesNotMatch(minimal, /ship tier 2/);

    const autoCtx = autoDiscoverProjectContext(root, [], { contextMode: "auto" });
    assert.match(autoCtx, /Real Project Notes/);
    assert.doesNotMatch(autoCtx, /Managed bridge instructions/);
    assert.doesNotMatch(autoCtx, /Self skill should be excluded/);
});
