/** Plan extension: Pi integration and the single mode-transition entry point. */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPlanToolConfiguration } from "./config.ts";
import {
	buildExecuteMessage,
	buildPlanExecutionMessage,
	createControlPayload,
	loadPlanPrompts,
	messageText,
	normalizePlanContext,
	renderPlanPrompt,
	type MessageLike,
	type PlanDirective,
	type PlanPrompts,
} from "./context.ts";
import {
	findLatestPlanState,
	modeFromState,
	PLAN_STATE_TYPE,
	toPersistedState,
	type ModeOrigin,
	type PersistedPlanStateV2,
	type PlanMode,
	type RuntimePlanState,
	type SessionEntryLike,
} from "./state.ts";
import { PLAN_EXECUTE_MESSAGE_TYPE, PLAN_PROPOSAL_ENTRY_TYPE, registerPlanRenderers, type PlanProposalEntryData } from "./renderer.ts";
import { extractPlanChecklist, extractProposedPlan, findToolViolation, normalizeAdditionalPlanTools, restoreAvailableTools, selectPlanTools } from "./utils.ts";

const defaultExtensionDir = path.dirname(fileURLToPath(import.meta.url));

export interface PlanExtensionOptions {
	extensionDir?: string;
	prompts?: PlanPrompts;
	schedule?: (task: () => void) => void;
	allowedTools?: readonly string[];
}

interface ModeResult {
	kind: "applied" | "pending" | "canceled" | "unchanged";
	mode: PlanMode;
}

function unique(names: readonly string[]): string[] {
	return Array.from(new Set(names));
}

export function registerPlanExtension(pi: ExtensionAPI, options: PlanExtensionOptions = {}): void {
	const loaded = options.prompts
		? { prompts: options.prompts, diagnostics: [] as string[] }
		: loadPlanPrompts(options.extensionDir ?? defaultExtensionDir);
	const prompts = loaded.prompts;
	registerPlanRenderers(pi);
	const schedule = options.schedule ?? ((task: () => void) => setImmediate(task));
	const optionAllowedTools = normalizeAdditionalPlanTools(options.allowedTools ?? []);
	const reportedDiagnostics = new Set<string>();

	let configuredPlanTools = [...optionAllowedTools];
	let planToolDiagnostics: string[] = [];
	let state: RuntimePlanState = { mode: "execute", revision: 0 };
	let beforeStartSeen = false;
	let actionPromptOpen = false;
	let executeGeneration = 0;
	let pendingExecuteMessage: string | undefined;
	let proposedPlan: string | undefined;
	let appendedPlanForRun: string | undefined;

	function availableTools(): string[] {
		return unique(pi.getAllTools().map((tool) => tool.name));
	}

	function selectTools(availableNames: readonly string[], activeNames: readonly string[]): string[] {
		return selectPlanTools(availableNames, activeNames, configuredPlanTools);
	}

	function refreshPlanTools(ctx: ExtensionContext): void {
		const configured = loadPlanToolConfiguration({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		configuredPlanTools = unique([...optionAllowedTools, ...configured.tools]);
		planToolDiagnostics = configured.diagnostics;
	}

	function persist(): void {
		pi.appendEntry(PLAN_STATE_TYPE, toPersistedState(state));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = state.pending
			? ctx.ui.theme.fg("warning", `⏳ ${state.mode} → ${state.pending.target}`)
			: state.mode === "plan"
				? ctx.ui.theme.fg("warning", "⏸ plan")
				: undefined;
		ctx.ui.setStatus("plan", text);
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	}

	function notify(ctx: ExtensionContext, message: string): void {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function reportDiagnostics(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		for (const diagnostic of [...loaded.diagnostics, ...planToolDiagnostics]) {
			if (reportedDiagnostics.has(diagnostic)) continue;
			reportedDiagnostics.add(diagnostic);
			ctx.ui.notify(diagnostic, "warning");
		}
	}

	/** Every mode source, including hydration, passes through this function. */
	function requestMode(
		target: PlanMode,
		origin: ModeOrigin,
		ctx: ExtensionContext,
		restored?: PersistedPlanStateV2,
	): ModeResult {
		if (origin === "hydrate") {
			const targetState = restored ?? { enabled: false, revision: 0 };
			const active = unique(pi.getActiveTools());
			const available = availableTools();
			const outgoingSnapshot = state.mode === "plan" ? state.toolsBeforePlan : undefined;
			const activeSet = new Set(active);
			const disabledInOutgoingPlan = new Set(
				state.mode === "plan" && outgoingSnapshot
					? selectTools(available, outgoingSnapshot).filter((name) => !activeSet.has(name))
					: [],
			);
			const keepCurrentChoices = (baseline: string[]) =>
				state.mode === "execute"
					? baseline.filter((name) => activeSet.has(name))
					: baseline.filter((name) => !disabledInOutgoingPlan.has(name));

			if (target === "plan") {
				const savedBaseline = targetState.toolsBeforePlan ?? outgoingSnapshot ?? active;
				// Use the target branch snapshot, while carrying explicit /tools disables
				// instead of the automatic restrictions from the outgoing Plan branch.
				const baseline = keepCurrentChoices(savedBaseline);
				pi.setActiveTools(selectTools(available, baseline));
				state = {
					mode: "plan",
					revision: targetState.revision,
					toolsBeforePlan: [...baseline],
				};
			} else {
				const savedBaseline = targetState.toolsBeforePlan ?? outgoingSnapshot;
				const baseline = savedBaseline ? keepCurrentChoices(savedBaseline) : undefined;
				if (baseline) pi.setActiveTools(restoreAvailableTools(baseline, available));
				state = {
					mode: "execute",
					revision: targetState.revision,
					toolsBeforePlan: baseline ? [...baseline] : undefined,
					notice: targetState.notice ? { ...targetState.notice } : undefined,
				};
			}
			beforeStartSeen = false;
			updateStatus(ctx);
			return { kind: "applied", mode: state.mode };
		}

		if (!ctx.isIdle()) {
			if (target === state.mode) {
				const canceled = state.pending !== undefined;
				state.pending = undefined;
				updateStatus(ctx);
				if (canceled && origin === "manual") notify(ctx, "Pending Plan mode switch canceled.");
				return { kind: canceled ? "canceled" : "unchanged", mode: state.mode };
			}
			state.pending = { target, origin };
			updateStatus(ctx);
			if (origin === "manual") {
				notify(ctx, `Plan mode will switch to ${target} after the current run settles; this run remains in ${state.mode}.`);
			}
			return { kind: "pending", mode: state.mode };
		}

		if (target === state.mode) {
			state.pending = undefined;
			updateStatus(ctx);
			return { kind: "unchanged", mode: state.mode };
		}

		const revision = state.revision + 1;
		const available = availableTools();
		if (target === "plan") {
			const baseline = unique(pi.getActiveTools());
			const tools = selectTools(available, baseline);
			pi.setActiveTools(tools);
			state = { mode: "plan", revision, toolsBeforePlan: baseline };
			if (origin === "manual") notify(ctx, `Plan enabled. Tools: ${tools.join(", ") || "none"}.`);
		} else {
			const baseline = state.toolsBeforePlan ?? unique(pi.getActiveTools());
			pi.setActiveTools(restoreAvailableTools(baseline, available));
			state = {
				mode: "execute",
				revision,
				toolsBeforePlan: [...baseline],
				notice: origin === "manual" ? { kind: "inactive", revision } : undefined,
			};
			if (origin === "manual") notify(ctx, "Plan disabled. The previous plan will not be executed automatically.");
		}
		persist();
		updateStatus(ctx);
		return { kind: "applied", mode: state.mode };
	}

	function invalidateDeferredExecute(): void {
		pendingExecuteMessage = undefined;
		executeGeneration += 1;
	}

	function resetProposedPlan(): void {
		proposedPlan = undefined;
		appendedPlanForRun = undefined;
	}

	function captureProposedPlan(messages: readonly MessageLike[]): void {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role !== "assistant") continue;
			const text = messageText(message);
			const plan = extractProposedPlan(text);
			const steps = extractPlanChecklist(text);
			if (plan && steps.length > 0) {
				proposedPlan = plan;
				if (appendedPlanForRun !== plan) {
					pi.appendEntry<PlanProposalEntryData>(PLAN_PROPOSAL_ENTRY_TYPE, {
						plan,
						stepCount: steps.length,
					});
					appendedPlanForRun = plan;
				}
				return;
			}
		}
		if (appendedPlanForRun === undefined) proposedPlan = undefined;
	}

	function handleManualToggle(ctx: ExtensionContext): void {
		invalidateDeferredExecute();
		resetProposedPlan();
		reportDiagnostics(ctx);
		const desired = state.pending?.target ?? state.mode;
		requestMode(desired === "plan" ? "execute" : "plan", "manual", ctx);
	}

	function currentDirective(): PlanDirective | undefined {
		if (!state.runControl) return undefined;
		return {
			owner: "plan",
			...state.runControl,
			content:
				state.runControl.kind === "active" ? renderPlanPrompt(prompts.plan, pi.getActiveTools()) : prompts.inactive,
		};
	}

	function scheduleExecute(content: string): void {
		const generation = ++executeGeneration;
		schedule(() => {
			if (generation !== executeGeneration || state.mode !== "execute" || state.pending?.target === "plan") return;
			pi.sendMessage(
				{
					customType: PLAN_EXECUTE_MESSAGE_TYPE,
					content,
					display: true,
					details: { owner: "plan", kind: "execute", revision: state.revision },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	function requestExecute(content: string, ctx: ExtensionContext): void {
		const result = requestMode("execute", "execute", ctx);
		if (result.kind === "pending") pendingExecuteMessage = content;
		else if (result.mode === "execute") scheduleExecute(content);
	}

	function compactThenExecute(ctx: ExtensionContext, plan: string): void {
		const generation = ++executeGeneration;
		const executeMessage = buildPlanExecutionMessage(prompts.execute, plan);
		notify(ctx, "Compacting context before execution...");
		ctx.compact({
			onComplete: () => {
				if (generation !== executeGeneration || state.mode !== "plan") return;
				requestExecute(executeMessage, ctx);
			},
			onError: (error) => {
				if (generation !== executeGeneration || state.mode !== "plan") return;
				notify(ctx, `Context compaction failed: ${error.message}`);
			},
		});
	}

	async function showActionPrompt(ctx: ExtensionContext, requested = false): Promise<void> {
		if (!ctx.hasUI) return;
		if (!ctx.isIdle()) {
			if (requested) notify(ctx, "Plan menu is unavailable while Pi is running. Try /plan menu after it settles.");
			return;
		}
		if (state.mode !== "plan") {
			if (requested) notify(ctx, "Plan mode is disabled. Use /plan to enable it.");
			return;
		}
		if (actionPromptOpen) {
			if (requested) notify(ctx, "Plan menu is already open.");
			return;
		}
		const plan = proposedPlan;
		if (!plan) {
			if (requested) notify(ctx, "No current plan is available. Ask for an implementation plan first.");
			return;
		}

		actionPromptOpen = true;
		const promptGeneration = executeGeneration;
		try {
			const choice = await ctx.ui.select("Plan - what next?", [
				"Execute",
				"Compact context and execute",
				"Execute with additional instructions",
				"Stay in plan mode",
			]);
			if (promptGeneration !== executeGeneration) return;
			if (!choice || choice === "Stay in plan mode") {
				notify(ctx, "Staying in Plan. Use /plan menu to reopen the choices.");
				return;
			}

			if (choice === "Compact context and execute") {
				compactThenExecute(ctx, plan);
				return;
			}

			let executeMessage: string | undefined;
			if (choice === "Execute") {
				executeMessage = buildExecuteMessage(prompts.execute);
			} else if (choice === "Execute with additional instructions") {
				const extra = await ctx.ui.input("Additional execution instructions:", "Describe what to add before execution...");
				if (promptGeneration !== executeGeneration) return;
				if (!extra?.trim()) {
					notify(ctx, "No additional instructions provided. Staying in Plan. Use /plan menu to reopen the choices.");
					return;
				}
				executeMessage = buildExecuteMessage(prompts.execute, extra);
			}
			if (!executeMessage) return;

			requestExecute(executeMessage, ctx);
		} finally {
			actionPromptOpen = false;
		}
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (analysis, no main-agent write operations)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use /plan menu to reopen the execution choices",
		getArgumentCompletions: (prefix) => "menu".startsWith(prefix.trim().toLowerCase())
			? [{ value: "menu", label: "menu", description: "Reopen the current plan's execution choices" }]
			: null,
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command) handleManualToggle(ctx);
			else if (command === "menu") await showActionPrompt(ctx, true);
			else notify(ctx, "Usage: /plan to toggle plan mode; /plan menu to reopen the execution choices.");
		},
	});

	pi.registerShortcut("alt+i", {
		description: "Toggle plan mode",
		handler: handleManualToggle,
	});

	pi.on("tool_call", async (event) => {
		if ((state.runMode ?? state.mode) !== "plan") return;
		const violation = findToolViolation(event.toolName, event.input);
		if (violation) return { block: true, reason: `Plan: ${violation}. Disable Plan or choose Execute first.` };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		reportDiagnostics(ctx);
		if (state.runMode === undefined) {
			invalidateDeferredExecute();
			resetProposedPlan();
		}
		beforeStartSeen = true;
		state.runMode = state.mode;
		if (state.mode === "plan") {
			state.runControl = { kind: "active", revision: state.revision };
		} else if (state.notice) {
			state.runControl = { kind: "inactive", revision: state.notice.revision };
			state.notice = undefined;
			persist();
		} else {
			state.runControl = undefined;
		}
		const directive = currentDirective();
		return directive ? { message: createControlPayload(directive) } : undefined;
	});

	// Custom triggerTurn runs bypass before_agent_start.
	pi.on("agent_start", async () => {
		if (beforeStartSeen) {
			beforeStartSeen = false;
			return;
		}
		// A retry/compaction retry starts another low-level run before agent_settled.
		// Keep the top-level run snapshot and its one-time inactive directive intact.
		if (state.runMode !== undefined) return;
		resetProposedPlan();
		state.runMode = state.mode;
		state.runControl = state.mode === "plan" ? { kind: "active", revision: state.revision } : undefined;
	});

	pi.on("agent_end", async (event) => {
		if (state.runMode !== "plan") return;
		captureProposedPlan(event.messages as unknown as MessageLike[]);
	});

	pi.on("context", async (event) => ({
		messages: normalizePlanContext(event.messages as unknown as MessageLike[], currentDirective()) as unknown as typeof event.messages,
	}));

	pi.on("agent_settled", async (_event, ctx) => {
		// Another extension may already have started a new turn. Its lifecycle hooks
		// own runMode/runControl now, so leave both pending and run state untouched.
		if (!ctx.isIdle()) return;

		const completedRunMode = state.runMode;
		state.runMode = undefined;
		state.runControl = undefined;
		beforeStartSeen = false;

		if (state.pending) {
			const pending = state.pending;
			const executeMessage = pending.target === "execute" ? pendingExecuteMessage : undefined;
			pendingExecuteMessage = undefined;
			requestMode(pending.target, pending.origin, ctx);
			if (executeMessage && state.mode === "execute") scheduleExecute(executeMessage);
			return;
		}

		if (completedRunMode === "plan") await showActionPrompt(ctx);
	});

	function hydrateCurrentBranch(ctx: ExtensionContext): void {
		invalidateDeferredExecute();
		resetProposedPlan();
		const restored = findLatestPlanState(ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
		requestMode(modeFromState(restored), "hydrate", ctx, restored);
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshPlanTools(ctx);
		reportDiagnostics(ctx);
		hydrateCurrentBranch(ctx);
		if (pi.getFlag("plan") === true) requestMode("plan", "startup", ctx);
	});

	pi.on("session_tree", async (_event, ctx) => hydrateCurrentBranch(ctx));
	pi.on("session_shutdown", async () => invalidateDeferredExecute());
}

export default function planExtension(pi: ExtensionAPI): void {
	registerPlanExtension(pi);
}
