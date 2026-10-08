import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { PlanMode } from "./state.ts";

export const PLAN_STATUS_WIDGET_KEY = "picraft-plan-mode";

export function formatPlanModeStatus(mode: PlanMode, pendingTarget?: PlanMode): string {
	if (pendingTarget) return `⏳ ${mode} → ${pendingTarget}`;
	return mode === "plan" ? "⏸ plan" : "▶ normal";
}

export function createPlanModeStatusComponent(
	theme: Theme,
	mode: PlanMode,
	pendingTarget?: PlanMode,
): Component {
	const text = formatPlanModeStatus(mode, pendingTarget);
	const color = mode === "plan" || pendingTarget ? "warning" : "muted";
	return {
		render(width: number): string[] {
			return [truncateToWidth(theme.fg(color, text), Math.max(1, width), "", false)];
		},
		invalidate() {},
	};
}
