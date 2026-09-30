import assert from "node:assert/strict";
import { test } from "node:test";

import {
	formatThroughputDetails,
	formatThroughputStatus,
	ThroughputTracker,
} from "./state.ts";

test("throughput uses provider-reported cumulative output and excludes TTFT", () => {
	const tracker = new ThroughputTracker();
	tracker.start(0, "model-x");
	tracker.update(undefined, 10, 500);
	tracker.update(undefined, 20, 1_500);
	const snapshot = tracker.finish(20, 2_000);

	assert.equal(snapshot.outputTokens, 20);
	assert.equal(snapshot.estimated, false);
	assert.equal(snapshot.ttftMs, 500);
	assert.equal(snapshot.elapsedMs, 1_500);
	assert.equal(snapshot.average, 20_000 / 1_500);
	assert.match(formatThroughputStatus(snapshot), new RegExp("13.3 tok/s"));
	assert.match(formatThroughputDetails(snapshot), /model-x/);
});

test("throughput falls back to estimated delta tokens", () => {
	const tracker = new ThroughputTracker();
	tracker.start(0);
	tracker.update("12345678", undefined, 1_000);
	const snapshot = tracker.finish(undefined, 2_000);

	assert.equal(snapshot.outputTokens, 2);
	assert.equal(snapshot.estimated, true);
	assert.equal(snapshot.ttftMs, 1_000);
	assert.match(formatThroughputStatus(snapshot), /~/);
});

test("reset returns an idle snapshot", () => {
	const tracker = new ThroughputTracker();
	tracker.start(0);
	tracker.update("hello", undefined, 1_000);
	tracker.reset();

	assert.deepEqual(tracker.snapshot(2_000), {
		phase: "idle",
		outputTokens: 0,
		estimated: true,
	});
});
