import assert from "node:assert/strict";
import { test } from "node:test";

import { PermissionAuthority } from "../authority.ts";
import type { PermissionRequest } from "../core.ts";

const request = {
	toolName: "read",
	title: "Read outside project",
	detail: "/workspace/outside/item.txt",
	requirements: [
		{
			permission: "external_directory" as const,
			access: "read" as const,
			pattern: "/workspace/outside/item.txt",
			alwaysPattern: "/workspace/outside/*",
			reason: "outside",
		},
	],
} satisfies PermissionRequest;

test("allow_all auto-approves permission requests without prompting", async () => {
	const authority = new PermissionAuthority();
	let promptCount = 0;
	authority.setMode("session", "allow_all");

	const result = await authority.authorize({
		sessionId: "session",
		requestId: "auto",
		request,
		isAborted: () => false,
		hasUI: false,
		decide: async () => {
			promptCount++;
			return { kind: "reject" };
		},
	});

	assert.deepEqual(result.decision, { kind: "auto" });
	assert.equal(promptCount, 0);
	assert.equal(authority.grantsFor("session").list().length, 0);
	assert.equal(authority.modeFor("session"), "allow_all");
});

test("switching back to ask does not persist the allow_all mode", async () => {
	const authority = new PermissionAuthority();
	authority.setMode("session", "allow_all");
	authority.setMode("session", "ask");

	const result = await authority.authorize({
		sessionId: "session",
		requestId: "headless",
		request,
		isAborted: () => false,
		hasUI: false,
		decide: async () => ({ kind: "always" }),
	});

	assert.deepEqual(result.decision, { kind: "reject" });
	assert.equal(authority.modeFor("session"), "ask");
});
