import { describe, expect, it } from "vitest";
import { buildKanbanManagedKimiHooksToml } from "../../../src/terminal/kimi-hook-config";

// Kanban 托管的 kimi `[[hooks]]` 片段：事件名必须是 kimi-code 自己的 Claude 风格名，kanban 事件经 CLI 参数传。

describe("buildKanbanManagedKimiHooksToml", () => {
	it("注册 PostCompact → 压缩完成事件（推进 Cache warm 起点）", () => {
		const toml = buildKanbanManagedKimiHooksToml();
		const postCompactTable = toml.split("[[hooks]]").find((table) => table.includes('event = "PostCompact"'));
		expect(postCompactTable).toBeDefined();
		expect(postCompactTable).toContain("main_agent_conversation_context_compaction_completed");
		expect(postCompactTable).toContain("--source");
	});

	it("SessionStart 仍映射为身份事件（kimi 压缩时不触发 SessionStart）", () => {
		const toml = buildKanbanManagedKimiHooksToml();
		const sessionStartTable = toml.split("[[hooks]]").find((table) => table.includes('event = "SessionStart"'));
		expect(sessionStartTable).toContain("agent_conversation_session_identity_observed");
	});
});
