import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { stripProposedPlanBlock } from "./utils.ts";

export const PLAN_PROPOSAL_ENTRY_TYPE = "plan-proposal";
export const PLAN_EXECUTE_MESSAGE_TYPE = "plan-execute";

export interface PlanProposalEntryData {
	plan: string;
	stepCount: number;
}

/** Register the TUI renderers used by Plan without changing model-visible content. */
export function registerPlanRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PlanProposalEntryData>(PLAN_PROPOSAL_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data?.plan?.trim()) return new Text(theme.fg("warning", "📋 Proposed Plan unavailable"), 0, 0);

		const stepLabel = Number.isSafeInteger(data.stepCount) && data.stepCount > 0 ? ` · ${data.stepCount} steps` : "";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				`${theme.fg("accent", "📋")} ${theme.bold(theme.fg("accent", "Proposed Plan"))}${theme.fg("muted", stepLabel)}`,
				0,
				0,
			),
		);
		box.addChild(new Markdown(data.plan.trim(), 0, 1, getMarkdownTheme()));
		return box;
	});

	pi.registerMessageRenderer(PLAN_EXECUTE_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", "▶ Executing approved plan"), 0, 0));
		return box;
	});

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (messageType !== "assistant" || isStreaming) return markdown;
		return stripProposedPlanBlock(markdown);
	});
}
