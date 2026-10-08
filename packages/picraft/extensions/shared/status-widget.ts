import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_WIDGET_KEY = "picraft-permission-throughput";
const STATUS_RUNTIME_KEY = Symbol.for("pi-craft.permission-throughput-status.v1");

type PicraftStatusRuntime = {
	sessionId?: string;
	state: PicraftStatusState;
};

type PicraftGlobal = typeof globalThis & {
	[key: symbol]: PicraftStatusRuntime | undefined;
};

const picraftGlobal = globalThis as PicraftGlobal;

export type PicraftStatusKey = "permission" | "throughput";

export interface PicraftStatusValue {
	text: string;
	color: ThemeColor;
}

export interface PicraftStatusState {
	permission?: PicraftStatusValue;
	throughput?: PicraftStatusValue;
}

function getStatusRuntime(): PicraftStatusRuntime {
	const existing = picraftGlobal[STATUS_RUNTIME_KEY];
	if (existing) return existing;
	const runtime: PicraftStatusRuntime = { state: {} };
	picraftGlobal[STATUS_RUNTIME_KEY] = runtime;
	return runtime;
}

function ensureStatusSession(ctx: ExtensionContext): PicraftStatusRuntime {
	const runtime = getStatusRuntime();
	const sessionId = ctx.sessionManager.getSessionId();
	if (runtime.sessionId !== sessionId) {
		runtime.sessionId = sessionId;
		runtime.state = {};
	}
	return runtime;
}

export function updatePicraftStatus(
	ctx: ExtensionContext,
	key: PicraftStatusKey,
	value: PicraftStatusValue | undefined,
): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	const runtime = ensureStatusSession(ctx);
	runtime.state = { ...runtime.state, [key]: value };
	renderPicraftStatusWidget(ctx, runtime);
}

export function refreshPicraftStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	renderPicraftStatusWidget(ctx, ensureStatusSession(ctx));
}

export function clearPicraftStatus(ctx: ExtensionContext): void {
	const runtime = getStatusRuntime();
	runtime.sessionId = undefined;
	runtime.state = {};
	if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
}

function renderPicraftStatusWidget(ctx: ExtensionContext, runtime: PicraftStatusRuntime): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	if (!runtime.state.permission && !runtime.state.throughput) {
		ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(
		STATUS_WIDGET_KEY,
		(_tui, theme) => createPicraftStatusComponent(theme),
		{ placement: "belowEditor" },
	);
}
export function createPicraftStatusComponent(theme: Theme): Component {
	return {
		render(width: number): string[] {
			return renderPicraftStatusLines(getStatusRuntime().state, theme, width);
		},
		invalidate() {},
	};
}

export function renderPicraftStatusLines(
	state: PicraftStatusState,
	theme: Theme,
	width: number,
): string[] {
	const renderWidth = Math.max(1, width);
	const permission = state.permission ? style(theme, state.permission) : undefined;
	const throughput = state.throughput ? style(theme, state.throughput) : undefined;
	const secondLine = composeStatusLine(permission, throughput, renderWidth);
	return secondLine ? [secondLine] : [];
}

function composeStatusLine(left: string | undefined, right: string | undefined, width: number): string | undefined {
	if (!left && !right) return undefined;
	if (!left) return truncateToWidth(right!, width, "", false);
	if (!right) return truncateToWidth(left, width, "", false);

	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "", false);
	const leftDisplay = truncateToWidth(left, Math.max(1, width - rightWidth - 2), "", false);
	const gap = " ".repeat(Math.max(2, width - visibleWidth(leftDisplay) - rightWidth));
	return truncateToWidth(`${leftDisplay}${gap}${right}`, width, "", false);
}

function style(theme: Theme, value: PicraftStatusValue): string {
	return theme.fg(value.color, value.text);
}
