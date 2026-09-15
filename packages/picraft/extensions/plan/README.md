# Plan Extension

Plan mode for Pi 0.80.4+. It lets the main agent inspect and plan while withholding its normal write tools, then returns to execution only through an explicit mode change.

Plan classifies each new request during the Plan turn. Inquiries, explanations, comparisons, and code-reading questions are answered directly. A request that intends to change the workspace is treated as a task and must produce a `<proposed_plan>` checklist before the execution choices are shown. A response without a valid plan never opens the execution prompt.

## Entry points

- `/plan` and `Alt+I` call the same manual-toggle handler.
- `--plan` enables Plan after session state is restored, so it overrides a persisted disabled state.
- `Execute`, `Execute with additional instructions`, `Compact context and execute`, and `Continue conversation` are shown only after an interactive Plan turn produces a valid implementation checklist. `Execute` is the default choice.

Every transition passes through the single `requestMode()` function in `index.ts`. A switch requested while Pi is running becomes an in-memory pending target; the current run keeps its captured mode and the final target is applied only after `agent_settled` reports Pi idle.

Manual exit is not Execute. It only changes mode and records a one-shot inactive notice for the next real user prompt. Explicit Execute restores tools and sends one `followUp` message with `triggerTurn: true`.

The execution choices are:

1. `Execute`: restore the previous tools and execute the approved plan.
2. `Execute with additional instructions`: collect extra instructions, then execute.
3. `Compact context and execute`: compact first; after compaction completes, inject the saved `<proposed_plan>` into a new execution message, restore tools, and execute.
4. `Continue conversation`: keep Plan mode active without executing. Esc has the same behavior as this option.

## Request routing

The Plan prompt asks the model to distinguish inquiries from implementation tasks after inspecting the available facts. An inquiry is answered directly and does not produce an execution prompt. A task must place its implementation plan inside one `<proposed_plan>` block with at least one numbered or checkbox step. The runtime uses that block as the execution gate, so an ordinary numbered list in an answer does not start execution.

A mixed request that includes an intended workspace change is treated as a task. The execution choices remain explicit: creating a plan never starts implementation by itself.

## Structure

```text
plan/
├── index.ts       # Pi registration, lifecycle, and requestMode
├── config.ts      # trusted global/project additional-tool configuration
├── state.ts       # persisted/runtime state and branch-state decoding
├── context.ts     # prompts and hidden-context normalization
├── utils.ts       # tool intersection and bounded write guard
├── prompts/
└── tests/
```

The extension intentionally has no adapter/controller/ports hierarchy. Pi side effects remain in `index.ts`; the other modules expose small helpers without importing Pi types.

## State and branches

New state entries use `customType: "plan-state"`:

```ts
interface PersistedPlanStateV2 {
  enabled: boolean;
  revision: number;
  toolsBeforePlan?: string[];
  notice?: { kind: "inactive"; revision: number };
}
```

Legacy `plan-state` or `plan-mode` entries containing `{ enabled }` remain readable. Pending state is never persisted. Restoration reads only `sessionManager.getBranch()` and does not append a new entry, so sibling branches do not leak mode state.

Entering Plan snapshots the complete active tool list. Plan tools are:

```text
Plan candidates ∩ registered tools ∩ tools active in the relevant snapshot
```

Leaving Plan restores the snapshot after filtering tools no longer registered.

### Additional analysis tools

Extra tools can be appended to the Plan candidates through strict JSON configuration. Global configuration is read from `~/.pi/agent/picraft.json`; project configuration is read from `<cwd>/.pi/picraft.json` only when Pi trusts that project.

```json
{
  "plan": {
    "tools": ["codegraph_explore", "codegraph_search", "memory_search"]
  }
}
```

Global and project entries are merged and de-duplicated. An additional tool is retained only when it is also registered and active before entering Plan. `registerPlanExtension()` also accepts `allowedTools` for programmatic setup.

`edit`, `write`, and `powershell` cannot be added through this configuration. Pi exposes no generic read-only marker for extension tools, so every other configured custom tool is an explicit trust decision; only list tools whose implementation is known to be read-only.

## Subagent boundary

Plan has no Subagent protocol or policy. It treats `subagent` like any other Pi tool and retains it only when it is already registered and active. It does not import Subagent code, inspect agent files, or activate the tool.

A writable/full-access subagent can therefore modify the workspace while the main agent is in Plan. The main-agent guard does not provide process isolation; disable or restrict Subagent separately when stronger isolation is required.

## Write guard

While a run is captured in Plan, `edit` and `write` are blocked and malformed Bash input is rejected. `utils.ts` also blocks a short list of common Unix, Git, dependency, system, and PowerShell mutations while allowing ordinary inspection commands. Direct Bash null-device redirection is allowed only through `/dev/null`; CMD and PowerShell spellings such as `NUL` and `$null` are treated as file redirection.

This is a best-effort planning guard, not a security sandbox. The rule set is deliberately bounded rather than attempting to parse every shell grammar or program.
