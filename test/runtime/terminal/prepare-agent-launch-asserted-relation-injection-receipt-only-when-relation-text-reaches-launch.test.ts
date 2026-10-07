import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveInterWorkUnitRelationNeighborhoodSessionStartInjectionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/prompts/inter-work-unit-relation-neighborhood-append-system-prompt", () => ({
	resolveInterWorkUnitRelationNeighborhoodSessionStartInjection:
		resolveInterWorkUnitRelationNeighborhoodSessionStartInjectionMock,
}));

import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

// 带引号与换行：codex 以 JSON 字符串字面量放进 `-c developer_instructions=…`，查验必须认得转义后的形式。
const RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT =
	'# Kanban Relations Of This Task\n\n## Declared unilaterally by another work unit\n- task a0001 "Diagnose the resume path" concerns this task';

const originalHome = process.env.HOME;
let temporaryHomeDirectoryPath: string | null = null;
const commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded = vi.fn();

function launchInputFor(agentId: RuntimeAgentId, overrides: { prompt?: string; args?: string[] } = {}) {
	return {
		taskId: "b0002",
		agentId,
		binary: agentId,
		args: overrides.args ?? [],
		cwd: "/tmp/repo",
		prompt: overrides.prompt ?? "Rewrite the resume path",
	};
}

beforeEach(() => {
	temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-injection-receipt-launch-"));
	process.env.HOME = temporaryHomeDirectoryPath;
	commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded.mockReset();
	resolveInterWorkUnitRelationNeighborhoodSessionStartInjectionMock.mockReset();
	resolveInterWorkUnitRelationNeighborhoodSessionStartInjectionMock.mockResolvedValue({
		interWorkUnitRelationNeighborhoodAppendSystemPromptText: RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT,
		commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
	});
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (temporaryHomeDirectoryPath) {
		rmSync(temporaryHomeDirectoryPath, { recursive: true, force: true });
		temporaryHomeDirectoryPath = null;
	}
});

// dd2db 2.1 注入回执只记「真的进了会话」的那一次：解析阶段不记，prepareAgentLaunch 只在 adapter 产出的启动确实
// 带上了关系段时才交出提交回调（由 session-manager 在 spawn 成功之后调用）。
describe("prepareAgentLaunch hands out the injection receipt commit only when the relation text reaches the launch", () => {
	it("hands it out when claude appends the relation text to its system prompt, and resolving alone records nothing", async () => {
		const launch = await prepareAgentLaunch(launchInputFor("claude"));

		expect(launch.args.some((arg) => arg.includes(RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT))).toBe(true);
		expect(commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).not.toHaveBeenCalled();
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBe(
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
		);
	});

	it("hands it out when codex carries the relation text JSON-escaped in developer_instructions", async () => {
		const launch = await prepareAgentLaunch(launchInputFor("codex"));

		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBe(
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
		);
	});

	it("hands it out when kiro carries the relation text in its Kanban-managed agent config file", async () => {
		const launch = await prepareAgentLaunch(launchInputFor("kiro"));

		expect(launch.args).toContain("--agent");
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBe(
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
		);
	});

	it("withholds it when the prompt is empty and the adapter only prepends the relation text to the first prompt", async () => {
		const launch = await prepareAgentLaunch(launchInputFor("gemini", { prompt: "" }));

		expect(launch.args.some((arg) => arg.includes("# Kanban Relations Of This Task"))).toBe(false);
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBeUndefined();
	});

	it("withholds it when claude keeps the user's own --system-prompt and does not append the relation text", async () => {
		const launch = await prepareAgentLaunch(
			launchInputFor("claude", { args: ["--system-prompt", "user supplied system prompt"] }),
		);

		expect(launch.args.some((arg) => arg.includes("# Kanban Relations Of This Task"))).toBe(false);
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBeUndefined();
	});

	it("Kimi 的延迟首轮输入携带关系段时提供注入回执", async () => {
		const launch = await prepareAgentLaunch(launchInputFor("kimi"));

		expect(launch.deferredStartupPromptText).toContain(RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT);
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBe(
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
		);
		expect(commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).not.toHaveBeenCalled();
	});

	it("withholds it when the injected text lists no asserted relation", async () => {
		resolveInterWorkUnitRelationNeighborhoodSessionStartInjectionMock.mockResolvedValue({
			interWorkUnitRelationNeighborhoodAppendSystemPromptText: RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT,
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded: null,
		});
		const launch = await prepareAgentLaunch(launchInputFor("claude"));

		expect(launch.args.some((arg) => arg.includes(RELATION_NEIGHBORHOOD_APPEND_SYSTEM_PROMPT_TEXT))).toBe(true);
		expect(launch.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toBeUndefined();
	});

	it("never commits when the adapter preparation fails", async () => {
		// kiro 要把托管 agent 配置写进 ~/.kiro/agents；让 ~/.kiro 是个文件，写入必然失败。
		const temporaryHome = temporaryHomeDirectoryPath ?? "";
		mkdirSync(temporaryHome, { recursive: true });
		writeFileSync(join(temporaryHome, ".kiro"), "not a directory");

		await expect(prepareAgentLaunch(launchInputFor("kiro"))).rejects.toThrow();
		expect(commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).not.toHaveBeenCalled();
	});
});
