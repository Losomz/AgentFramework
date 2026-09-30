import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { PermissionRequest } from "./core.ts";
import { presentPermissionRequest } from "./presentation.ts";

export const PERMISSION_AUDIT_ENTRY = "permission-audit";
export const PERMISSION_SUMMARY_ENTRY = "permission-summary";

const MAX_RECENT_RECORDS = 20;
const MAX_SCOPES = 8;
const MAX_DISPLAY_LENGTH = 160;

export type PermissionActivityAuthorization = "auto" | "once" | "always" | "grant" | "reject" | "deny";
export type PermissionActivityState = "running" | "succeeded" | "failed" | "blocked";

export interface PermissionActivityRecord {
	version: 1;
	id: string;
	toolCallId: string;
	agentName?: string;
	toolName: string;
	summary: string;
	target: string;
	scopes: string[];
	authorization: PermissionActivityAuthorization;
	state: PermissionActivityState;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
}

export interface PermissionActivityEvent {
	version: 1;
	phase: "start" | "finish";
	record: PermissionActivityRecord;
}

export interface PermissionActivitySummaryRecord {
	version: 1;
	allowed: number;
	blocked: number;
	failed: number;
	total: number;
	startedAt: number;
	endedAt: number;
}

interface ActivityCounts {
	allowed: number;
	blocked: number;
	failed: number;
}

export class PermissionActivityTracker {
	private readonly pending = new Map<string, PermissionActivityRecord>();
	private readonly active = new Map<string, PermissionActivityRecord>();
	private recent: PermissionActivityRecord[] = [];
	private counts: ActivityCounts = { allowed: 0, blocked: 0, failed: 0 };
	private runStartedAt = Date.now();

	register(toolCallId: string, request: PermissionRequest, cwd: string): PermissionActivityRecord {
		const presentation = presentPermissionRequest(request, cwd, homedir());
		const target = request.toolName === "bash"
			? presentation.sessionScopes.map((scope) => `${scope.label}: ${scope.scope}`).join(", ") || "external command"
			: presentation.target;
		const record: PermissionActivityRecord = {
			version: 1,
			id: randomUUID(),
			toolCallId,
			...(request.agentName?.trim() ? { agentName: request.agentName.trim() } : {}),
			toolName: cleanDisplay(request.toolName, 48),
			summary: cleanDisplay(presentation.summary, 96),
			target: cleanDisplay(target, MAX_DISPLAY_LENGTH),
			scopes: presentation.sessionScopes.slice(0, MAX_SCOPES).map((scope) => cleanDisplay(`${scope.label}: ${scope.scope}`, MAX_DISPLAY_LENGTH)),
			authorization: "grant",
			state: "running",
			startedAt: 0,
		};
		this.pending.set(toolCallId, record);
		return record;
	}

	setAuthorization(toolCallId: string, authorization: PermissionActivityAuthorization): boolean {
		const record = this.pending.get(toolCallId);
		if (!record) return false;
		record.authorization = authorization;
		return true;
	}

	markRunning(toolCallId: string, startedAt = Date.now()): PermissionActivityEvent | undefined {
		const record = this.pending.get(toolCallId);
		if (!record) return undefined;
		const running = { ...record, state: "running" as const, startedAt };
		this.pending.set(toolCallId, running);
		this.active.set(running.id, running);
		return { version: 1, phase: "start", record: running };
	}

	finish(
		toolCallId: string,
		state: Exclude<PermissionActivityState, "running">,
		endedAt = Date.now(),
	): PermissionActivityEvent | undefined {
		const record = this.pending.get(toolCallId);
		if (!record) return undefined;
		const startedAt = record.startedAt || endedAt;
		const finished = {
			...record,
			state,
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
		};
		this.pending.delete(toolCallId);
		this.active.delete(record.id);
		this.addRecent(finished);
		this.counts = {
			allowed: this.counts.allowed + (state === "succeeded" ? 1 : 0),
			blocked: this.counts.blocked + (state === "blocked" ? 1 : 0),
			failed: this.counts.failed + (state === "failed" ? 1 : 0),
		};
		return { version: 1, phase: "finish", record: finished };
	}

	applyRemote(event: PermissionActivityEvent): void {
		if (event.phase === "start") {
			this.active.set(event.record.id, { ...event.record });
			return;
		}
		this.active.delete(event.record.id);
		this.addRecent(event.record);
		this.counts = {
			allowed: this.counts.allowed + (event.record.state === "succeeded" ? 1 : 0),
			blocked: this.counts.blocked + (event.record.state === "blocked" ? 1 : 0),
			failed: this.counts.failed + (event.record.state === "failed" ? 1 : 0),
		};
	}

	resetRun(): void {
		this.pending.clear();
		this.active.clear();
		this.recent = [];
		this.counts = { allowed: 0, blocked: 0, failed: 0 };
		this.runStartedAt = Date.now();
	}

	activeRecords(): PermissionActivityRecord[] {
		return Array.from(this.active.values());
	}

	recentRecords(): PermissionActivityRecord[] {
		return this.recent.map((record) => ({ ...record, scopes: [...record.scopes] }));
	}

	summary(endedAt = Date.now()): PermissionActivitySummaryRecord | undefined {
		const total = this.counts.allowed + this.counts.blocked + this.counts.failed;
		if (total === 0) return undefined;
		return {
			version: 1,
			...this.counts,
			total,
			startedAt: this.runStartedAt,
			endedAt,
		};
	}

	private addRecent(record: PermissionActivityRecord): void {
		this.recent = [...this.recent, { ...record, scopes: [...record.scopes] }].slice(-MAX_RECENT_RECORDS);
	}
}

export function permissionActivityWidgetLines(
	tracker: PermissionActivityTracker,
	expanded = false,
): string[] | undefined {
	const active = tracker.activeRecords();
	if (!expanded) {
		if (active.length === 0) return undefined;
		if (active.length === 1) {
			return ["External access · 1 active", formatActivityLine("ACTIVE", active[0])];
		}
		return [
			`External access · ${active.length} active`,
			"Use /permissions list to view the full list",
		];
	}

	const recent = tracker.recentRecords();
	if (active.length === 0 && recent.length === 0) return undefined;
	const lines = [`External access${active.length > 0 ? ` · ${active.length} active` : ""}`];
	for (const record of active) lines.push(formatActivityLine("ACTIVE", record));
	if (recent.length > 0) {
		lines.push("Recent");
		for (const record of recent) lines.push(formatActivityLine(stateLabel(record.state), record));
	}
	return lines;
}

export function registerPermissionActivityRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PermissionActivityRecord>(PERMISSION_AUDIT_ENTRY, (entry, _options, theme) => {
		const record = entry.data;
		if (!record || record.version !== 1) return new Text(theme.fg("warning", "External access record unavailable"), 0, 0);
		return new Text(styleRecord(theme, record), 0, 0);
	});
	pi.registerEntryRenderer<PermissionActivitySummaryRecord>(PERMISSION_SUMMARY_ENTRY, (entry, _options, theme) => {
		const summary = entry.data;
		if (!summary || summary.version !== 1) return new Text(theme.fg("warning", "External permission summary unavailable"), 0, 0);
		return new Text(
			theme.fg(
				"accent",
				`External permissions · ${summary.allowed} allowed · ${summary.blocked} blocked · ${summary.failed} failed`,
			),
			0,
			0,
		);
	});
}

export function formatPermissionModeStatus(mode: "ask" | "allow_all", activeCount = 0): string {
	const suffix = activeCount > 0 ? ` · ${activeCount} active` : "";
	return mode === "allow_all" ? `perm: ALL (session)${suffix}` : `perm: ASK${suffix}`;
}

function formatActivityLine(status: string, record: PermissionActivityRecord): string {
	const agent = cleanDisplay(record.agentName || "Main", 32);
	const duration = record.durationMs === undefined ? "" : ` ${formatDuration(record.durationMs)}`;
	return `${status.padEnd(7)} ${agent}  ${record.toolName}  ${record.target}${duration}`;
}

function styleRecord(theme: Theme, record: PermissionActivityRecord): string {
	const authorization = record.authorization.toUpperCase();
	const status = stateLabel(record.state);
	const agent = cleanDisplay(record.agentName || "Main", 32);
	const duration = record.durationMs === undefined ? "" : ` ${formatDuration(record.durationMs)}`;
	const text = `External access · ${authorization} · ${agent} · ${record.toolName} · ${record.target} · ${status}${duration}`;
	if (record.state === "succeeded") return theme.fg("success", text);
	if (record.state === "blocked" || record.state === "failed") return theme.fg("error", text);
	return theme.fg("warning", text);
}

function stateLabel(state: PermissionActivityState): string {
	if (state === "succeeded") return "DONE";
	if (state === "failed") return "ERROR";
	if (state === "blocked") return "BLOCKED";
	return "RUN";
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function cleanDisplay(value: string, maximum: number): string {
	const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
	if (normalized.length <= maximum) return normalized;
	return `${normalized.slice(0, Math.max(1, maximum - 3)).trimEnd()}...`;
}
