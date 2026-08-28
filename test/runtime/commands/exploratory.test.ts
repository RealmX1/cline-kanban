import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCClientError } from "@trpc/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	deliverExploratorySessionMapUpdate,
	parseExploratoryMapUpdatePayload,
	readExploratoryPayloadText,
	resolveExploratoryCommandScope,
	resolveExploratoryPayloadSource,
} from "../../../src/commands/exploratory";
import type { RuntimeIngestExploratorySessionMapUpdateResponse } from "../../../src/core/api-contract";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "../../../src/terminal/hook-runtime-context";

// exploratory CLI 纯函数层的行为锁测：payload 三形态、flag/env 优先级与不一致报错、廉价校验文案、
// 投递骨架的三态适配（applied=false 业务结果 / TRPCClientError 业务拒绝 / 传输重试）。
const FAST_DELIVERY_OPTIONS = { timeoutMs: 5, maxAttempts: 2, backoffMs: 0 } as const;

function createIngestResponse(
	overrides: Partial<RuntimeIngestExploratorySessionMapUpdateResponse> = {},
): RuntimeIngestExploratorySessionMapUpdateResponse {
	return {
		applied: true,
		rejectionReason: null,
		mapCollection: null,
		...overrides,
	};
}

describe("resolveExploratoryPayloadSource", () => {
	it("把内联 JSON 原样识别为 inline", () => {
		expect(resolveExploratoryPayloadSource('{"clientProposalId":"p1"}')).toEqual({
			kind: "inline",
			text: '{"clientProposalId":"p1"}',
		});
	});

	it('把 "@<path>" 识别为文件引用', () => {
		expect(resolveExploratoryPayloadSource("@/tmp/payload.json")).toEqual({
			kind: "file",
			path: "/tmp/payload.json",
		});
	});

	it('把 "-" 识别为 stdin', () => {
		expect(resolveExploratoryPayloadSource("-")).toEqual({ kind: "stdin" });
	});

	it("裸 @ 缺路径时报人话错误", () => {
		expect(() => resolveExploratoryPayloadSource("@")).toThrow(/missing a path/);
	});
});

describe("readExploratoryPayloadText", () => {
	const tempDirectories: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("inline 形态不碰文件与 stdin，原样返回", async () => {
		const readStdin = vi.fn(async () => "stdin-should-not-be-read");
		await expect(readExploratoryPayloadText('{"a":1}', readStdin)).resolves.toBe('{"a":1}');
		expect(readStdin).not.toHaveBeenCalled();
	});

	it("@file 形态读文件内容", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-exploratory-payload-"));
		tempDirectories.push(directory);
		const payloadPath = join(directory, "payload.json");
		await writeFile(payloadPath, '{"clientProposalId":"p1"}', "utf8");

		await expect(readExploratoryPayloadText(`@${payloadPath}`)).resolves.toBe('{"clientProposalId":"p1"}');
	});

	it("@file 读不到文件时报含路径的人话错误", async () => {
		await expect(readExploratoryPayloadText("@/nonexistent/kanban-payload.json")).rejects.toThrow(
			/Could not read payload file "\/nonexistent\/kanban-payload\.json"/,
		);
	});

	it('"-" 形态走注入的 stdin 读取器', async () => {
		const readStdin = vi.fn(async () => '{"clientProposalId":"p2"}');
		await expect(readExploratoryPayloadText("-", readStdin)).resolves.toBe('{"clientProposalId":"p2"}');
		expect(readStdin).toHaveBeenCalledTimes(1);
	});
});

describe("parseExploratoryMapUpdatePayload", () => {
	it("接受白名单三键齐全的合法 payload", () => {
		expect(
			parseExploratoryMapUpdatePayload(
				JSON.stringify({
					clientProposalId: "proposal-1",
					sourceTurnProjectionSignature: "12:msg-9:340",
					nodes: [{ anchorTurnNumber: 3, nodeKind: "milestone", nodeTitle: "定下方向" }],
				}),
			),
		).toEqual({
			clientProposalId: "proposal-1",
			sourceTurnProjectionSignature: "12:msg-9:340",
			nodes: [{ anchorTurnNumber: 3, nodeKind: "milestone", nodeTitle: "定下方向" }],
		});
	});

	it("JSON.parse 失败时报人话错误", () => {
		expect(() => parseExploratoryMapUpdatePayload("{not json")).toThrow(/not valid JSON/);
	});

	it.each([["[1,2]"], ['"text"'], ["null"], ["42"]])("非对象 JSON（%s）报人话错误", (text) => {
		expect(() => parseExploratoryMapUpdatePayload(text)).toThrow(/must be a JSON object/);
	});

	it("缺 clientProposalId 报人话错误", () => {
		expect(() =>
			parseExploratoryMapUpdatePayload(JSON.stringify({ sourceTurnProjectionSignature: "s", nodes: [] })),
		).toThrow(/missing required string field "clientProposalId"/);
	});

	it("缺 sourceTurnProjectionSignature 报人话错误", () => {
		expect(() => parseExploratoryMapUpdatePayload(JSON.stringify({ clientProposalId: "p", nodes: [] }))).toThrow(
			/missing required string field "sourceTurnProjectionSignature"/,
		);
	});

	it("nodes 非数组报人话错误", () => {
		expect(() =>
			parseExploratoryMapUpdatePayload(
				JSON.stringify({ clientProposalId: "p", sourceTurnProjectionSignature: "s", nodes: {} }),
			),
		).toThrow(/"nodes" must be an array/);
	});
});

describe("resolveExploratoryCommandScope", () => {
	it("flag 与 env 同时存在且一致时正常解析", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", workspaceId: "ws-1" },
				{ [KANBAN_HOOK_TASK_ID_ENV]: "task-1", [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-1" },
			),
		).resolves.toEqual({ taskId: "task-1", workspaceId: "ws-1" });
	});

	it("只有 flag 时用 flag", async () => {
		await expect(resolveExploratoryCommandScope({ task: "task-1", workspaceId: "ws-1" }, {})).resolves.toEqual({
			taskId: "task-1",
			workspaceId: "ws-1",
		});
	});

	it("只有 env 时用 env（flag 缺省回退）", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{},
				{ [KANBAN_HOOK_TASK_ID_ENV]: "task-env", [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-env" },
			),
		).resolves.toEqual({ taskId: "task-env", workspaceId: "ws-env" });
	});

	it("task flag 与 env 不一致 → 硬报错，绝不静默选边（单任务作用域纪律）", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-flag" },
				{ [KANBAN_HOOK_TASK_ID_ENV]: "task-env", [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-1" },
			),
		).rejects.toThrow(
			/--task \("task-flag"\) conflicts with environment variable .*KANBAN_HOOK_TASK_ID.*\("task-env"\)/,
		);
	});

	it("workspace flag 与 env 不一致 → 硬报错", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", workspaceId: "ws-flag" },
				{ [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-env" },
			),
		).rejects.toThrow(/--workspace-id \("ws-flag"\) conflicts with environment variable .*KANBAN_HOOK_WORKSPACE_ID/);
	});

	it("task 与 workspace 都缺 → 报缺少 task id", async () => {
		await expect(resolveExploratoryCommandScope({}, {})).rejects.toThrow(/Missing task id/);
	});

	it("只有 task、缺 workspace → 报缺少 workspace id", async () => {
		await expect(resolveExploratoryCommandScope({ task: "task-1" }, {})).rejects.toThrow(/Missing workspace id/);
	});
});

// --project-path 是 workspace 的第三种解析来源（Cline SDK 会话没有 hook env 注入）：
// --workspace-id flag > --project-path > env，两两不一致硬报错。路径解析器注入替身，
// 不碰真实 workspace 索引。
describe("resolveExploratoryCommandScope（--project-path workspace 解析）", () => {
	it("只有 --project-path 时用其解析结果", async () => {
		const resolvePath = vi.fn(async () => "ws-from-path");
		await expect(
			resolveExploratoryCommandScope({ task: "task-1", projectPath: "/repo/main" }, {}, resolvePath),
		).resolves.toEqual({ taskId: "task-1", workspaceId: "ws-from-path" });
		expect(resolvePath).toHaveBeenCalledWith("/repo/main");
	});

	it("flag > --project-path > env：三来源同时在场且一致时正常解析", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", workspaceId: "ws-1", projectPath: "/repo/main" },
				{ [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-1" },
				async () => "ws-1",
			),
		).resolves.toEqual({ taskId: "task-1", workspaceId: "ws-1" });
	});

	it("--workspace-id 与 --project-path 解析结果不一致 → 硬报错", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", workspaceId: "ws-flag", projectPath: "/repo/main" },
				{},
				async () => "ws-path",
			),
		).rejects.toThrow(
			/--workspace-id \("ws-flag"\) conflicts with --project-path \(resolved workspace\) \("ws-path"\)/,
		);
	});

	it("--project-path 与 env 不一致 → 硬报错", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", projectPath: "/repo/main" },
				{ [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-env" },
				async () => "ws-path",
			),
		).rejects.toThrow(
			/--project-path \(resolved workspace\) \("ws-path"\) conflicts with environment variable .*KANBAN_HOOK_WORKSPACE_ID \("ws-env"\)/,
		);
	});

	it("--project-path 与 flag 一致但 env 不一致 → 仍硬报错（两两校验，无静默多数决）", async () => {
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", workspaceId: "ws-1", projectPath: "/repo/main" },
				{ [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-env" },
				async () => "ws-1",
			),
		).rejects.toThrow(/--workspace-id \("ws-1"\) conflicts with environment variable/);
	});

	it("workspace 三来源全缺 → 报错文案列全三种补法", async () => {
		await expect(resolveExploratoryCommandScope({ task: "task-1" }, {})).rejects.toThrow(
			/Missing workspace id\. Pass --workspace-id <id>, --project-path <path>, or set .*KANBAN_HOOK_WORKSPACE_ID/,
		);
	});

	it("project path 未注册 → 解析器的错误原样上抛", async () => {
		await expect(
			resolveExploratoryCommandScope({ task: "task-1", projectPath: "/repo/unregistered" }, {}, async () => {
				throw new Error("Project /repo/unregistered is not added to Kanban yet.");
			}),
		).rejects.toThrow("Project /repo/unregistered is not added to Kanban yet.");
	});

	it("--project-path 为空白 → 视为未提供，落 env 兜底且不调用解析器", async () => {
		const resolvePath = vi.fn(async () => "ws-path");
		await expect(
			resolveExploratoryCommandScope(
				{ task: "task-1", projectPath: "   " },
				{ [KANBAN_HOOK_WORKSPACE_ID_ENV]: "ws-env" },
				resolvePath,
			),
		).resolves.toEqual({ taskId: "task-1", workspaceId: "ws-env" });
		expect(resolvePath).not.toHaveBeenCalled();
	});

	it("只给 --project-path 而 task 无 flag/env → 报 Missing task id（提示 --task 与 env 两种补法），且不触碰路径解析", async () => {
		const resolvePath = vi.fn(async () => "ws-path");
		await expect(resolveExploratoryCommandScope({ projectPath: "/repo/main" }, {}, resolvePath)).rejects.toThrow(
			/Missing task id\. Pass --task <taskId> or set .*KANBAN_HOOK_TASK_ID/,
		);
		expect(resolvePath).not.toHaveBeenCalled();
	});
});

describe("deliverExploratorySessionMapUpdate", () => {
	it("applied=false 是业务结果而非失败：正常 resolve，rejectionReason 随响应带出", async () => {
		const rejected = createIngestResponse({
			applied: false,
			rejectionReason: "stale_source_turn_projection_signature",
		});
		const mutate = vi.fn(async () => rejected);

		await expect(deliverExploratorySessionMapUpdate(mutate, FAST_DELIVERY_OPTIONS)).resolves.toEqual(rejected);
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it("TRPCClientError（schema/procedure 拒绝）按业务拒绝处理：立即抛、不重试、message 原样保留", async () => {
		const mutate = vi.fn(async (): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> => {
			throw new TRPCClientError("referencedFindingId 仅允许出现在 finding_reference 节点上");
		});

		await expect(deliverExploratorySessionMapUpdate(mutate, FAST_DELIVERY_OPTIONS)).rejects.toThrow(
			"referencedFindingId 仅允许出现在 finding_reference 节点上",
		);
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it("非 TRPCClientError 的抛出按传输故障处理：有界重试后抛出", async () => {
		let attempt = 0;
		const mutate = vi.fn(async (): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("fetch failed");
			}
			return createIngestResponse();
		});

		await expect(deliverExploratorySessionMapUpdate(mutate, FAST_DELIVERY_OPTIONS)).resolves.toEqual(
			createIngestResponse(),
		);
		expect(mutate).toHaveBeenCalledTimes(2);
	});

	it("传输故障重试耗尽后抛出最后一次错误", async () => {
		const mutate = vi.fn(async (): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> => {
			throw new Error("fetch failed");
		});

		await expect(deliverExploratorySessionMapUpdate(mutate, FAST_DELIVERY_OPTIONS)).rejects.toThrow("fetch failed");
		expect(mutate).toHaveBeenCalledTimes(2);
	});
});
