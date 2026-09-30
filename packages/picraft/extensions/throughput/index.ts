import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	formatThroughputDetails,
	formatThroughputStatus,
	ThroughputTracker,
} from "./state.ts";

const STATUS_KEY = "throughput";

export default function throughputExtension(pi: ExtensionAPI): void {
	const tracker = new ThroughputTracker();
	let enabled = true;

	const render = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatThroughputStatus(tracker.snapshot())));
	};

	pi.on("session_start", (_event, ctx) => {
		tracker.reset();
		enabled = true;
		render(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		tracker.start(Date.now(), event.message.model);
		render(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		const delta = "delta" in streamEvent && typeof streamEvent.delta === "string" ? streamEvent.delta : undefined;
		tracker.update(delta, event.message.usage.output, Date.now());
		render(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		tracker.finish(event.message.usage.output, Date.now(), event.message.model);
		render(ctx);
	});

	pi.registerCommand("throughput", {
		description: "查看或控制当前 AI 吞吐速度",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on") {
				enabled = true;
				render(ctx);
				return;
			}
			if (command === "off") {
				enabled = false;
				render(ctx);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(formatThroughputDetails(tracker.snapshot()), "info");
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
