import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createPlanModeStatusComponent, formatPlanModeStatus } from "./status.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

test("Plan status distinguishes Plan and normal mode", () => {
	assert.equal(formatPlanModeStatus("plan"), "⏸ plan");
	assert.equal(formatPlanModeStatus("execute"), "▶ normal");
	assert.equal(formatPlanModeStatus("execute", "plan"), "⏳ execute → plan");
});

test("Plan status truncates without overflowing narrow widths", () => {
	const component = createPlanModeStatusComponent(theme, "plan");
	const lines = component.render(6);

	assert.equal(lines.length, 1);
	assert.ok(visibleWidth(lines[0] ?? "") <= 6);
});
