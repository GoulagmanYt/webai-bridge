---
name: webai-orchestrator
description: Autonomous closed-loop orchestration via WebAI Bridge. Use when delegating non-trivial architecture, multi-file refactors, or complex debugging to the browser Web AI Orchestrator through consult_orchestrator.
---

# WebAI Orchestrator — Closed-Loop Cadence

1. **When to Trigger**: Delegate non-trivial design, multi-file edits, or deep debugging to `consult_orchestrator` (one call at a time; check `orchestrator_status` if unsure). Handle trivial one-line edits locally.
2. **Closed-Loop Discipline (Zero Human Interruption)**:
   - Turn 1: send concise project/task brief + minimal necessary `filePaths` (or `path:start-end` slices).
   - Inspect returned `PATCH:` (`SEARCH/REPLACE`), `FILE:`, `DELETE:`, or `RENAME:` blocks for safety, apply inside `projectRoot`, and run verification tests/builds autonomously.
   - Check the reply envelope `loop=continue|complete`:
     - While `loop=continue` (including prose/analysis/diagnostic turns), **do not stop or ask the human user** — immediately call `consult_orchestrator` with a compact execution delta (failing tests/errors/applied changes only).
     - Stop and report to the human user **only** when `loop=complete` (standalone `TASK_COMPLETE` received) or on a physical blocker (`NO_TAB`, `NO_INPUT`, `GENERATION_NOT_STARTED`, or security refusal).
3. **Token Hygiene**: Prefer default `output_mode: "auto"` (`PATCH:` over full files), default `file_mode: "auto"` (incremental diffs), and compressed failure-only logs in follow-up deltas.
4. **Safety**: Write and apply edits only inside \`projectRoot\`; external reads/uploads are disallowed unless explicitly authorized via \`BRIDGE_EXTRA_ROOTS\`. Credentials (\`.env\`, keys) and \`.git\` are blocked automatically.
