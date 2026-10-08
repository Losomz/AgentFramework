import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	formatThroughputDetails,
	formatThroughputStatus,
	ThroughputTracker,
} from "./state.ts";
import { clearPicraftStatus, updatePicraftStatus } from "../shared/status-widget.ts";

const TICK_MS = 500;

export default function throughputExtension(pi: ExtensionAPI): void {
	const tracker = new ThroughputTracker();
	let enabled = true;
	let streaming = false;
	let currentContext: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const stopTicker = (): void => {
		if (ticker === undefined) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	const render = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		if (!ctx.hasUI) return;
		if (!enabled) {
			updatePicraftStatus(ctx, "throughput", undefined);
			return;
		}
		updatePicraftStatus(ctx, "throughput", {
			text: formatThroughputStatus(tracker.snapshot()),
			color: "accent",
		});
	};

	const startTicker = (): void => {
		if (currentContext?.mode !== "tui" || !currentContext.hasUI || ticker !== undefined) return;
		ticker = setInterval(() => {
			if (!streaming || currentContext === undefined) return;
			render(currentContext);
		}, TICK_MS);
	};

	pi.on("session_start", (_event, ctx) => {
		stopTicker();
		tracker.reset();
		enabled = true;
		streaming = false;
		render(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		tracker.start(Date.now(), event.message.model);
		streaming = true;
		render(ctx);
		startTicker();
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		const delta = "delta" in streamEvent && typeof streamEvent.delta === "string" ? streamEvent.delta : undefined;
		tracker.update(delta, event.message.usage.output, Date.now());
		streaming = true;
		currentContext = ctx;
		startTicker();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		tracker.finish(event.message.usage.output, Date.now(), event.message.model);
		streaming = false;
		stopTicker();
		render(ctx);
	});

	pi.registerCommand("throughput", {
		description: "查看或控制当前 AI 吞吐速度",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on") {
				enabled = true;
				render(ctx);
				if (streaming) startTicker();
				return;
			}
			if (command === "off") {
				enabled = false;
				stopTicker();
				render(ctx);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(formatThroughputDetails(tracker.snapshot()), "info");
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTicker();
		streaming = false;
		currentContext = undefined;
		clearPicraftStatus(ctx);
	});
}
