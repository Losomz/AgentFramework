import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderPicraftStatusLines, type PicraftStatusState } from "./status-widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const state: PicraftStatusState = {
	permission: { text: "⚿ perm ask", color: "accent" },
	throughput: { text: "↯ 13.3 tok/s", color: "accent" },
};

test("status widget joins Permission with throughput on one line", () => {
	const lines = renderPicraftStatusLines(state, theme, 60);

	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /⚿ perm ask/);
	assert.match(lines[0] ?? "", /13\.3 tok\/s/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
});

test("status widget truncates without overflowing narrow widths", () => {
	const lines = renderPicraftStatusLines(state, theme, 20);

	assert.equal(lines.length, 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
});

test("status widget stays empty until Permission or throughput has a value", () => {
	assert.deepEqual(renderPicraftStatusLines({}, theme, 60), []);
});

test("status modules share runtime across uncached extension imports", async () => {
	const permissionModule = await import(new URL("./status-widget.ts?permission-instance", import.meta.url).href);
	const throughputModule = await import(new URL("./status-widget.ts?throughput-instance", import.meta.url).href);
	const context = createStatusContext("session-a");

	permissionModule.clearPicraftStatus(context);
	permissionModule.updatePicraftStatus(context, "permission", { text: "⚿ perm ask", color: "accent" });
	throughputModule.updatePicraftStatus(context, "throughput", { text: "↯ 13.3 tok/s", color: "accent" });
	permissionModule.refreshPicraftStatus(context);

	const lines = permissionModule.createPicraftStatusComponent(theme).render(60);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /⚿ perm ask/);
	assert.match(lines[0] ?? "", /13\.3 tok\/s/);
});

test("status runtime resets once when the session changes", async () => {
	const permissionModule = await import(new URL("./status-widget.ts?session-permission-instance", import.meta.url).href);
	const throughputModule = await import(new URL("./status-widget.ts?session-throughput-instance", import.meta.url).href);
	const firstSession = createStatusContext("session-before");
	const nextSession = createStatusContext("session-after");

	permissionModule.clearPicraftStatus(firstSession);
	permissionModule.updatePicraftStatus(firstSession, "permission", { text: "⚿ perm ask", color: "accent" });
	throughputModule.updatePicraftStatus(firstSession, "throughput", { text: "↯ 13.3 tok/s", color: "accent" });
	throughputModule.updatePicraftStatus(nextSession, "throughput", { text: "↯ 0 tok/s", color: "accent" });

	const nextLines = permissionModule.createPicraftStatusComponent(theme).render(60);
	assert.equal(nextLines.length, 1);
	assert.doesNotMatch(nextLines[0] ?? "", /⚿ perm ask/);
	assert.match(nextLines[0] ?? "", /0 tok\/s/);

	permissionModule.updatePicraftStatus(nextSession, "permission", { text: "⚿ perm all (session)", color: "accent" });
	const restoredLines = permissionModule.createPicraftStatusComponent(theme).render(60);
	assert.match(restoredLines[0] ?? "", /⚿ perm all \(session\)/);
	assert.match(restoredLines[0] ?? "", /0 tok\/s/);
	permissionModule.clearPicraftStatus(nextSession);
});

function createStatusContext(sessionId: string): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => sessionId },
		ui: { setWidget: () => undefined },
	} as unknown as ExtensionContext;
}
