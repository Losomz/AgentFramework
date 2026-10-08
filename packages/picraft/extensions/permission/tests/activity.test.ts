import assert from "node:assert/strict";
import { test } from "node:test";

import {
	formatPermissionModeStatus,
	PermissionActivityTracker,
	permissionActivityLines,
} from "../activity.ts";
import type { PermissionRequest } from "../core.ts";

function externalReadRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
	return {
		toolName: "read",
		title: "Read outside project",
		detail: "/workspace/outside/config.json",
		requirements: [
			{
				permission: "external_directory",
				access: "read",
				pattern: "/workspace/outside/config.json",
				alwaysPattern: "/workspace/outside/*",
				reason: "outside",
			},
		],
		...overrides,
	};
}

test("activity tracks running and completed external access with a summary", () => {
	const tracker = new PermissionActivityTracker();
	const record = tracker.register("tool-1", externalReadRequest({ agentName: "Explore" }), "/workspace/project");
	tracker.setAuthorization("tool-1", "auto");

	const started = tracker.markRunning("tool-1", 1_000);
	assert.equal(started?.phase, "start");
	assert.equal(permissionActivityLines(tracker)?.[1].startsWith("ACTIVE"), true);

	const finished = tracker.finish("tool-1", "succeeded", 1_850);
	assert.equal(finished?.phase, "finish");
	assert.equal(finished?.record.id, record.id);
	assert.equal(finished?.record.authorization, "auto");
	assert.equal(finished?.record.durationMs, 850);
	assert.equal(permissionActivityLines(tracker, true)?.some((line) => line.startsWith("DONE")), true);
	assert.deepEqual(tracker.summary(2_000), {
		version: 1,
		allowed: 1,
		blocked: 0,
		failed: 0,
		total: 1,
		startedAt: tracker.summary(2_000)?.startedAt,
		endedAt: 2_000,
	});
});

test("bash audit targets contain scopes instead of the full command", () => {
	const tracker = new PermissionActivityTracker();
	const record = tracker.register(
		"tool-2",
		{
			toolName: "bash",
			title: "Shell command requires permission",
			detail: "$ curl --header TOKEN=secret https://example.test > /tmp/result.txt",
			requirements: [
			{
				permission: "external_directory",
				access: "write",
				pattern: "/tmp/result.txt",
				alwaysPattern: "/tmp/*",
				reason: "outside",
			},
			],
		},
		"/workspace/project",
	);

	assert.equal(record.target.includes("secret"), false);
	assert.equal(record.target.includes("TOKEN"), false);
	assert.equal(record.target.includes("External write"), true);
});

test("blocked access is counted and mode status is explicit", () => {
	const tracker = new PermissionActivityTracker();
	tracker.register("tool-3", externalReadRequest(), "/workspace/project");
	tracker.setAuthorization("tool-3", "reject");
	const event = tracker.finish("tool-3", "blocked", 3_000);

	assert.equal(event?.record.state, "blocked");
	assert.deepEqual(tracker.summary(3_100), {
		version: 1,
		allowed: 0,
		blocked: 1,
		failed: 0,
		total: 1,
		startedAt: tracker.summary(3_100)?.startedAt,
		endedAt: 3_100,
	});
	assert.equal(formatPermissionModeStatus("ask"), "⚿ perm ask");
	assert.equal(formatPermissionModeStatus("allow_all", 1), "⚿ perm all (session) · 1 active");
});


test("compact activity expands one active record and summarizes multiple records", () => {
	const tracker = new PermissionActivityTracker();
	tracker.register("tool-one", externalReadRequest(), "/workspace/project");
	tracker.markRunning("tool-one", 1_000);

	const single = permissionActivityLines(tracker);
	assert.equal(single?.[0], "External access · 1 active");
	assert.equal(single?.[1].startsWith("ACTIVE"), true);

	tracker.register("tool-two", externalReadRequest({ toolName: "write" }), "/workspace/project");
	tracker.markRunning("tool-two", 1_100);
	const multiple = permissionActivityLines(tracker);
	assert.deepEqual(multiple, [
		"External access · 2 active",
		"Use /permissions list to view the full list",
	]);

	const expanded = permissionActivityLines(tracker, true);
	assert.equal(expanded?.filter((line) => line.startsWith("ACTIVE")).length, 2);
});
