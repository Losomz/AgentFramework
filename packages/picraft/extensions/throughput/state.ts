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

interface TokenSample {
	timestamp: number;
	outputTokens: number;
}

const WINDOW_MS = 1_000;

export class ThroughputTracker {
	private startedAt?: number;
	private firstOutputAt?: number;
	private lastOutputAt?: number;
	private outputTokens = 0;
	private usedProviderUsage = false;
	private model?: string;
	private samples: TokenSample[] = [];
	private phase: ThroughputPhase = "idle";

	start(timestamp = Date.now(), model?: string): void {
		this.startedAt = timestamp;
		this.firstOutputAt = undefined;
		this.lastOutputAt = undefined;
		this.outputTokens = 0;
		this.usedProviderUsage = false;
		this.model = model;
		this.samples = [];
		this.phase = "streaming";
	}

	update(delta: string | undefined, reportedOutput: number | undefined, timestamp = Date.now()): void {
		if (this.startedAt === undefined) this.start(timestamp);
		if (this.phase === "complete") this.phase = "streaming";

		const estimatedDelta = estimateDeltaTokens(delta);
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
		this.samples.push({ timestamp, outputTokens: this.outputTokens });
		this.samples = this.samples.filter((sample) => timestamp - sample.timestamp <= WINDOW_MS);
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
		this.lastOutputAt = undefined;
		this.outputTokens = 0;
		this.usedProviderUsage = false;
		this.model = undefined;
		this.samples = [];
		this.phase = "idle";
	}

	snapshot(timestamp = Date.now()): ThroughputSnapshot {
		const end = this.lastOutputAt ?? timestamp;
		const generationStart = this.firstOutputAt;
		const elapsedMs = generationStart === undefined ? undefined : Math.max(0, end - generationStart);
		const average = elapsedMs && elapsedMs > 0 ? (this.outputTokens * 1_000) / elapsedMs : undefined;
		const current = this.phase === "complete" ? average : this.currentRate(timestamp);
		return {
			phase: this.phase,
			outputTokens: this.outputTokens,
			...(current === undefined ? {} : { throughput: current }),
			...(average === undefined ? {} : { average }),
			...(this.startedAt === undefined || this.firstOutputAt === undefined
				? {}
				: { ttftMs: Math.max(0, this.firstOutputAt - this.startedAt) }),
			...(elapsedMs === undefined ? {} : { elapsedMs }),
			...(this.model ? { model: this.model } : {}),
			estimated: !this.usedProviderUsage,
		};
	}

	private currentRate(timestamp: number): number | undefined {
		if (this.outputTokens <= 0 || this.lastOutputAt === undefined) return undefined;
		const recent = this.samples.find((sample) => timestamp - sample.timestamp <= WINDOW_MS);
		if (!recent) return this.snapshotAverage();
		const elapsed = Math.max(100, timestamp - recent.timestamp);
		const delta = this.outputTokens - recent.outputTokens;
		return delta > 0 ? (delta * 1_000) / elapsed : this.snapshotAverage();
	}

	private snapshotAverage(): number | undefined {
		if (this.firstOutputAt === undefined || this.lastOutputAt === undefined) return undefined;
		const elapsed = this.lastOutputAt - this.firstOutputAt;
		return elapsed > 0 ? (this.outputTokens * 1_000) / elapsed : undefined;
	}
}

export function estimateDeltaTokens(delta: string | undefined): number {
	if (!delta) return 0;
	return Math.max(1, Math.ceil(delta.length / 4));
}

export function formatThroughputStatus(snapshot: ThroughputSnapshot): string {
	if (snapshot.throughput === undefined) return "↯ -- tok/s";
	const estimate = snapshot.estimated ? "~" : "";
	return `↯ ${estimate}${snapshot.throughput.toFixed(1)} tok/s`;
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
