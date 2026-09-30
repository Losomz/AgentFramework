import {
	type ExtensionAPI,
	getAgentDir,
	getPackageDir,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	formatPermissionModeStatus,
	PERMISSION_AUDIT_ENTRY,
	PERMISSION_SUMMARY_ENTRY,
	permissionActivityWidgetLines,
	PermissionActivityTracker,
	registerPermissionActivityRenderers,
	type PermissionActivityAuthorization,
	type PermissionActivityEvent,
} from "./activity.ts";
import {
	claimPermissionExtensionRegistration,
	currentSessionId,
	getPermissionRuntime,
	isSubagentProcess,
	parentSessionId,
	permissionRequestId,
	releasePermissionExtensionRegistration,
	type PermissionAuthorizationMode,
} from "./authority.ts";
import {
	buildPermissionPathPolicy,
	extractSubmittedTempFiles,
	extractTerminalPasteFiles,
} from "./policy.ts";
import {
	evaluatePermissionPolicy,
	requirementAccess,
	type PermissionRequest,
} from "./core.ts";
import {
	loadParentGrantView,
	permissionForwardingRoot,
	PermissionForwardingServer,
	PermissionSnapshotStore,
	requestParentPermission,
	sendPermissionActivity,
} from "./forwarding.ts";
import { getOutstandingRequirements, type PermissionPromptDecision } from "./presentation.ts";
import { requestPermissionDecision } from "./ui.ts";

const PERMISSION_STATUS_KEY = "permission";
const PERMISSION_WIDGET_KEY = "permission-activity";

export default function permissionExtension(pi: ExtensionAPI): void {
	if (!claimPermissionExtensionRegistration()) return;
	const runtime = getPermissionRuntime();
	const authority = runtime.authority;
	const forwardingRoot = permissionForwardingRoot(getAgentDir());
	const childProcess = isSubagentProcess();
	const activity = new PermissionActivityTracker();
	const policyByCwd = new Map<string, ReturnType<typeof buildPermissionPathPolicy>>();
	let parentContext: ExtensionContext | undefined;
	let unsubscribeTerminalFileTrust: (() => void) | undefined;
	let activityListExpanded = false;

	registerPermissionActivityRenderers(pi);

	const renderActivity = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		try {
			const status = formatPermissionModeStatus(authority.modeFor(currentSessionId(ctx)), activity.activeRecords().length);
			ctx.ui.setStatus(PERMISSION_STATUS_KEY, ctx.ui.theme.fg("accent", status));
			ctx.ui.setWidget(
				PERMISSION_WIDGET_KEY,
				permissionActivityWidgetLines(activity, activityListExpanded),
				{ placement: "aboveEditor" },
			);
		} catch {
			// UI teardown must not affect permission decisions or audit delivery.
		}
	};

	const persistActivityEvent = (event: PermissionActivityEvent, ctx: ExtensionContext): void => {
		if (event.phase === "finish") pi.appendEntry(PERMISSION_AUDIT_ENTRY, event.record);
		renderActivity(ctx);
	};

	const emitActivityEvent = (event: PermissionActivityEvent, ctx: ExtensionContext): void => {
		if (childProcess) {
			const parentId = parentSessionId();
			if (parentId) {
				sendPermissionActivity(forwardingRoot, parentId, currentSessionId(ctx), event);
			}
			return;
		}
		persistActivityEvent(event, ctx);
	};

	const forwardingServer = new PermissionForwardingServer(
		forwardingRoot,
		(sessionId) => authority.refreshSnapshot(sessionId),
		(event) => {
			activity.applyRemote(event);
			if (parentContext) persistActivityEvent(event, parentContext);
		},
	);

	const choosePermissionMode = async (ctx: ExtensionContext, sessionId: string): Promise<void> => {
		const current = authority.modeFor(sessionId);
		const selected = await ctx.ui.select(
			`Permission mode [${permissionModeLabel(current)}]`,
			["Ask", "Allow all for this session", "Cancel"],
		);
		if (!selected || selected === "Cancel") return;
		if (selected === "Allow all for this session") {
			const confirmed = await ctx.ui.confirm(
				"Allow all external permissions for this session?",
				"External and sensitive-file permission requests will run without another prompt. Explicit policy denials remain blocked.",
			);
			if (!confirmed) return;
			authority.setMode(sessionId, "allow_all");
		} else {
			authority.setMode(sessionId, "ask");
		}
		renderActivity(ctx);
	};

	if (!childProcess) authority.configureSnapshotStore(new PermissionSnapshotStore(forwardingRoot));

	pi.on("session_start", (_event, ctx) => {
		if (childProcess) return;
		parentContext = ctx;
		activity.resetRun();
		activityListExpanded = false;
		const sessionId = currentSessionId(ctx);
		authority.activateSession(sessionId);
		renderActivity(ctx);
		forwardingServer.start(sessionId, async (forwarded) => {
			const result = await authority.authorize({
				sessionId,
				requestId: `forwarded:${forwarded.id}`,
				request: forwarded.request,
				isAborted: () => ctx.signal?.aborted ?? false,
				hasUI: ctx.hasUI,
				decide: (request) => requestPermissionDecision(ctx, request),
			});
			return result.decision ?? { kind: "grant" };
		});

		unsubscribeTerminalFileTrust?.();
		unsubscribeTerminalFileTrust = undefined;
		if (ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function") {
			// Pi reassembles each bracketed paste before terminal listeners run.
			unsubscribeTerminalFileTrust = ctx.ui.onTerminalInput((data) => {
				const files = extractTerminalPasteFiles(data);
				if (files.length > 0) authority.registerTrustedFiles(sessionId, files);
				return undefined;
			});
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		activity.resetRun();
		activityListExpanded = false;
		renderActivity(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (childProcess) return;
		const summary = activity.summary();
		if (summary) pi.appendEntry(PERMISSION_SUMMARY_ENTRY, summary);
		renderActivity(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const localSessionId = currentSessionId(ctx);
		const agentName = subagentName();
		const toolCall = { toolName: event.toolName, input: event.input as Record<string, unknown> };
		const policyKey = process.platform === "win32" ? ctx.cwd.toLowerCase() : ctx.cwd;
		let basePolicy = policyByCwd.get(policyKey);
		if (!basePolicy) {
			basePolicy = buildPermissionPathPolicy(ctx.cwd, {
				agentDir: getAgentDir(),
				packageDir: getPackageDir(),
			});
			policyByCwd.set(policyKey, basePolicy);
		}
		const sessionTrustedFiles = authority.trustedFiles(localSessionId);
		const localPolicy = sessionTrustedFiles.length === 0
			? basePolicy
			: {
				...basePolicy,
				approvedReadFiles: [...(basePolicy.approvedReadFiles ?? []), ...sessionTrustedFiles],
			};
		const policyDecision = evaluatePermissionPolicy(toolCall, ctx.cwd, localPolicy, agentName);
		if (policyDecision.effect === "deny") {
			return { block: true, reason: `Permission policy denied: ${policyDecision.reason}` };
		}
		if (policyDecision.effect === "allow") return undefined;
		const request = policyDecision.request;
		activity.register(event.toolCallId, request, ctx.cwd);

		let decision: PermissionPromptDecision | undefined;
		if (childProcess) {
			const parentId = parentSessionId();
			const firstView = parentId ? loadParentGrantView(forwardingRoot, parentId) : undefined;
			const isCovered = (view: NonNullable<typeof firstView>): boolean => {
				if (view.mode === "allow_all") return true;
				const inheritedRequest = evaluatePermissionPolicy(toolCall, ctx.cwd, {
					...localPolicy,
					approvedReadFiles: [
						...(localPolicy.approvedReadFiles ?? []),
						...view.approvedReadFiles,
					],
				}, agentName);
				return inheritedRequest.effect === "allow" ||
					(inheritedRequest.effect === "ask" && getOutstandingRequirements(inheritedRequest.request, view.grants).length === 0);
			};
			if (firstView && isCovered(firstView)) {
				const confirmedView = parentId ? loadParentGrantView(forwardingRoot, parentId) : undefined;
				if (confirmedView?.revision === firstView.revision && isCovered(confirmedView)) {
					activity.setAuthorization(event.toolCallId, confirmedView.mode === "allow_all" ? "auto" : "grant");
					return undefined;
				}
			}
			decision = parentId
				? await requestParentPermission({
					forwardingRoot,
					parentSessionId: parentId,
					requesterSessionId: localSessionId,
					requesterAgentName: agentName,
					request,
					isAborted: () => ctx.signal?.aborted ?? false,
				})
				: { kind: "reject" };
		} else {
			const result = await authority.authorize({
				sessionId: localSessionId,
				requestId: permissionRequestId(event.toolCallId),
				request,
				isAborted: () => ctx.signal?.aborted ?? false,
				hasUI: ctx.hasUI,
				decide: (restrictedRequest) => requestPermissionDecision(ctx, restrictedRequest),
			});
			decision = result.decision;
		}

		const authorization = (decision?.kind ?? "grant") as PermissionActivityAuthorization;
		activity.setAuthorization(event.toolCallId, authorization);
		if (decision?.kind === "reject") {
			const activityEvent = activity.finish(event.toolCallId, "blocked");
			if (activityEvent) emitActivityEvent(activityEvent, ctx);
			return permissionRejection(decision, childProcess, ctx.hasUI);
		}
		return undefined;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const activityEvent = activity.markRunning(event.toolCallId);
		if (activityEvent) emitActivityEvent(activityEvent, ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const activityEvent = activity.finish(event.toolCallId, event.isError ? "failed" : "succeeded");
		if (activityEvent) emitActivityEvent(activityEvent, ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		const details = event.details as { fullOutputPath?: unknown } | undefined;
		if (event.toolName === "bash" && typeof details?.fullOutputPath === "string") {
			authority.registerTrustedFile(currentSessionId(ctx), details.fullOutputPath);
		}
	});

	pi.on("input", (event, ctx) => {
		if (!childProcess && event.source !== "extension") {
			registerSubmittedFiles(authority, currentSessionId(ctx), event.text);
		}
		return { action: "continue" };
	});

	pi.registerCommand("permissions", {
		description: "Manage session permission grants and mode",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || childProcess) return;
			const sessionId = currentSessionId(ctx);
			const command = args.trim().toLowerCase();
			if (command === "list") {
				activityListExpanded = true;
				renderActivity(ctx);
				return;
			}
			if (command === "list close") {
				activityListExpanded = false;
				renderActivity(ctx);
				return;
			}
			if (command === "mode") {
				await choosePermissionMode(ctx, sessionId);
				return;
			}
			const grants = authority.grantsFor(sessionId);
			const rules = grants.list();
			const modeChoice = `Mode: ${permissionModeLabel(authority.modeFor(sessionId))}`;
			const choices = [
				modeChoice,
				...rules.map(formatRule),
				...(rules.length > 0 ? ["Clear all session grants"] : []),
				"Cancel",
			];
			const selected = await ctx.ui.select("Session permission grants", choices);
			if (!selected || selected === "Cancel") return;
			if (selected === modeChoice) {
				await choosePermissionMode(ctx, sessionId);
				return;
			}
			if (selected === "Clear all session grants") {
				grants.clear();
				return;
			}
			const rule = rules.find((item) => formatRule(item) === selected);
			if (rule) grants.remove(rule.permission, rule.alwaysPattern, requirementAccess(rule));
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTerminalFileTrust?.();
		unsubscribeTerminalFileTrust = undefined;
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus(PERMISSION_STATUS_KEY, undefined);
				ctx.ui.setWidget(PERMISSION_WIDGET_KEY, undefined);
			} catch {
				// UI teardown is already in progress.
			}
		}
		forwardingServer.stop();
		parentContext = undefined;
		authority.clearSession(currentSessionId(ctx));
		policyByCwd.clear();
		activity.resetRun();
		activityListExpanded = false;
		releasePermissionExtensionRegistration();
	});
}

function permissionModeLabel(mode: PermissionAuthorizationMode): string {
	return mode === "allow_all" ? "Allow all (session)" : "Ask";
}

function permissionRejection(
	decision: Extract<PermissionPromptDecision, { kind: "reject" }>,
	childProcess: boolean,
	hasUI: boolean,
): { block: true; reason: string } {
	if (decision.feedback) {
		return { block: true, reason: `Permission rejected by the user. User feedback: ${decision.feedback}` };
	}
	if (childProcess) {
		return { block: true, reason: "Permission denied by the parent conversation or permission forwarding is unavailable." };
	}
	return {
		block: true,
		reason: hasUI
			? "Permission rejected by the user."
			: "Permission denied because no interactive UI is available.",
	};
}

function registerSubmittedFiles(
	authority: ReturnType<typeof getPermissionRuntime>["authority"],
	sessionId: string,
	text: string,
): void {
	authority.registerTrustedFiles(sessionId, extractSubmittedTempFiles(text));
}

function subagentName(): string | undefined {
	if (!isSubagentProcess()) return undefined;
	return process.env.PI_SUBAGENT_NAME?.trim() || "Subagent";
}

function formatRule(rule: PermissionRequest["requirements"][number]): string {
	return `${rule.permission}:${requirementAccess(rule)}: ${rule.alwaysPattern}`;
}
