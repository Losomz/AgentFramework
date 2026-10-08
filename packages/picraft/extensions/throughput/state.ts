export type ThroughputPhase = "idle" | "streaming" | "complete";

export interface ThroughputSnapshot {
	phase: ThroughputPhase;
	outputTokens: number;
	throughput?: number;
	average?: number;
	ttftMs?: number;
	elapsedMs?: number;
	model?: string;
	estimated: boolean;
}

const TPS_WINDOW_MS = 3_500;

export class ThroughputTracker {
	private startedAt?: number;
	private firstOutputAt?: number;
	private firstTokenAt?: number;
	private lastOutputAt?: number;
	private lastChunkAt?: number;
	private outputTokens = 0;
	private liveTokens = 0;
	private usedProviderUsage = false;
	private model?: string;
	private phase: ThroughputPhase = "idle";

	start(timestamp = Date.now(), model?: string): void {
		this.startedAt = timestamp;
		this.firstOutputAt = undefined;
		this.firstTokenAt = undefined;
		this.lastOutputAt = undefined;
		this.lastChunkAt = undefined;
		this.outputTokens = 0;
		this.liveTokens = 0;
		this.usedProviderUsage = false;
		this.model = model;
		this.phase = "streaming";
	}

	update(delta: string | undefined, reportedOutput: number | undefined, timestamp = Date.now()): void {
		if (this.startedAt === undefined) this.start(timestamp);
		if (this.phase === "complete") this.phase = "streaming";

		const estimatedDelta = estimateDeltaTokens(delta);
		if (estimatedDelta > 0) {
			if (this.firstTokenAt === undefined) this.firstTokenAt = timestamp;
			this.lastChunkAt = timestamp;
			this.liveTokens += estimatedDelta;
		} else if (delta !== undefined) {
			this.lastChunkAt = timestamp;
		}

		const previousOutput = this.outputTokens;
		if (reportedOutput !== undefined && reportedOutput > 0 && reportedOutput >= previousOutput) {
			this.outputTokens = reportedOutput;
			this.usedProviderUsage = true;
		} else if (estimatedDelta > 0) {
			this.outputTokens += estimatedDelta;
		}

		if (this.outputTokens <= previousOutput) return;
		if (this.firstOutputAt === undefined) this.firstOutputAt = timestamp;
		this.lastOutputAt = timestamp;
	}

	finish(reportedOutput?: number, timestamp = Date.now(), model?: string): ThroughputSnapshot {
		if (this.startedAt === undefined) this.start(timestamp, model);
		if (model) this.model = model;
		if (reportedOutput !== undefined && reportedOutput >= this.outputTokens) {
			this.outputTokens = reportedOutput;
			this.usedProviderUsage = true;
		}
		if (this.outputTokens > 0 && this.firstOutputAt === undefined) this.firstOutputAt = this.startedAt;
		if (this.outputTokens > 0) this.lastOutputAt = timestamp;
		this.phase = "complete";
		return this.snapshot(timestamp);
	}

	reset(): void {
		this.startedAt = undefined;
		this.firstOutputAt = undefined;
		this.firstTokenAt = undefined;
		this.lastOutputAt = undefined;
		this.lastChunkAt = undefined;
		this.outputTokens = 0;
		this.liveTokens = 0;
		this.usedProviderUsage = false;
		this.model = undefined;
		this.phase = "idle";
	}

	snapshot(timestamp = Date.now()): ThroughputSnapshot {
		const end = this.lastOutputAt ?? timestamp;
		const generationStart = this.firstOutputAt;
		const elapsedMs = generationStart === undefined ? undefined : Math.max(0, end - generationStart);
		const average = elapsedMs && elapsedMs > 0 ? (this.outputTokens * 1_000) / elapsedMs : undefined;
		const current = this.phase === "complete" ? average : this.liveRate(timestamp);
		return {
			phase: this.phase,
			outputTokens: this.outputTokens,
			...(current === undefined ? {} : { throughput: current }),
			...(average === undefined ? {} : { average }),
			...(this.startedAt === undefined || this.firstTokenAt === undefined
				? {}
				: { ttftMs: Math.max(0, this.firstTokenAt - this.startedAt) }),
			...(elapsedMs === undefined ? {} : { elapsedMs }),
			...(this.model ? { model: this.model } : {}),
			estimated: !this.usedProviderUsage,
		};
	}

	private liveRate(timestamp: number): number | undefined {
		if (this.liveTokens <= 0 || this.startedAt === undefined || this.lastChunkAt === undefined) return undefined;
		if (timestamp - this.lastChunkAt > TPS_WINDOW_MS) return undefined;
		const elapsedSeconds = Math.max(1, (timestamp - this.startedAt) / 1_000);
		const rate = Math.round(this.liveTokens / elapsedSeconds);
		return rate > 0 ? rate : undefined;
	}
}

export function estimateDeltaTokens(delta: string | undefined): number {
	if (!delta) return 0;
	const compact = delta.replace(/\s/g, "");
	if (compact.length === 0) return 0;
	const cjkCount = (compact.match(/[\u3400-\u9fff]/g) ?? []).length;
	return Math.max(1, Math.ceil(cjkCount * 1.5 + (compact.length - cjkCount) / 4));
}

export function formatThroughputStatus(snapshot: ThroughputSnapshot): string {
	const ttft = snapshot.ttftMs === undefined ? "" : ` · TTFT ${snapshot.ttftMs}ms`;
	if (snapshot.throughput === undefined) return `↯ -- tok/s${ttft}`;
	const estimate = snapshot.estimated ? "~" : "";
	return `↯ ${estimate}${snapshot.throughput.toFixed(1)} tok/s${ttft}`;
}

export function formatThroughputDetails(snapshot: ThroughputSnapshot): string {
	const parts = [formatThroughputStatus(snapshot)];
	if (snapshot.average !== undefined) parts.push(`avg ${snapshot.average.toFixed(1)} tok/s`);
	if (snapshot.outputTokens > 0) parts.push(`↓${formatCount(snapshot.outputTokens)} tok`);
	if (snapshot.elapsedMs !== undefined) parts.push(`${(snapshot.elapsedMs / 1_000).toFixed(1)}s`);
	if (snapshot.ttftMs !== undefined) parts.push(`TTFT ${snapshot.ttftMs}ms`);
	if (snapshot.model) parts.push(snapshot.model);
	return parts.join(" · ");
}

function formatCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}
