// 续跑前的 plan 探针：回答「这段 Claude 对话死掉时，是不是还停在一个没批准的 plan 里」。
// 记录形状取自本机真实转录（Claude Code 2.1.x）：每回合一条 permission-mode 元数据、人工 user 记录自带
// permissionMode、plan 期间注入 plan_mode 附件、退出后注入 plan_mode_exit、ExitPlanMode 获批不带 is_error。
// 用真实文件系统夹具驱动（不 mock fs），探针接受 homeDirectoryPath 覆盖，不改 process.env.HOME。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	deriveClaudeConversationPlanModeStateFromTranscriptLines,
	MAX_TRANSCRIPT_TAIL_BYTES_PER_PLAN_MODE_PROBE_FILE,
	probeClaudeConversationPlanModeStateBeforeResume,
} from "../../../src/agent-session-history/persisted-agent-transcript-plan-mode-still-open-probe";

const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";
const EXIT_PLAN_MODE_TOOL_USE_ID = "toolu_exit_plan_mode_1";

let temporaryRootPath: string | null = null;

afterEach(() => {
	if (temporaryRootPath) {
		rmSync(temporaryRootPath, { recursive: true, force: true });
		temporaryRootPath = null;
	}
});

interface ProbeFixture {
	homeDirectoryPath: string;
	workspacePath: string;
	projectDirectoryName: string;
}

function createProbeFixture(): ProbeFixture {
	temporaryRootPath = mkdtempSync(join(tmpdir(), "kanban-plan-mode-probe-"));
	const homeDirectoryPath = join(temporaryRootPath, "home");
	const workspacePath = join(temporaryRootPath, "workspace", "repo");
	mkdirSync(homeDirectoryPath, { recursive: true });
	mkdirSync(workspacePath, { recursive: true });
	return {
		homeDirectoryPath,
		workspacePath,
		// 独立重算 Claude 的目录名编码（realpath 后非字母数字全换短横、保留前导短横），实现编码错了这里会红。
		projectDirectoryName: realpathSync(workspacePath).replace(/[^a-zA-Z0-9]/gu, "-"),
	};
}

function writeTranscript(fixture: ProbeFixture, sessionIdentity: string, records: unknown[]): void {
	const filePath = join(
		fixture.homeDirectoryPath,
		".claude",
		"projects",
		fixture.projectDirectoryName,
		`${sessionIdentity}.jsonl`,
	);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function permissionModeRecord(permissionMode: string): unknown {
	return { type: "permission-mode", permissionMode, sessionId: SESSION_A };
}

function humanUserRecord(permissionMode: string, text = "go on"): unknown {
	return { type: "user", permissionMode, isSidechain: false, message: { role: "user", content: text } };
}

function planModeAttachmentRecord(): unknown {
	return { type: "attachment", isSidechain: false, attachment: { type: "plan_mode", reminderType: "full" } };
}

function planModeExitAttachmentRecord(): unknown {
	return { type: "attachment", isSidechain: false, attachment: { type: "plan_mode_exit", planExists: true } };
}

function exitPlanModeToolUseRecord(): unknown {
	return {
		type: "assistant",
		isSidechain: false,
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: EXIT_PLAN_MODE_TOOL_USE_ID, name: "ExitPlanMode", input: { plan: "# Plan" } },
			],
		},
	};
}

function exitPlanModeToolResultRecord(approved: boolean): unknown {
	return {
		type: "user",
		isSidechain: false,
		message: {
			role: "user",
			content: [
				approved
					? {
							type: "tool_result",
							tool_use_id: EXIT_PLAN_MODE_TOOL_USE_ID,
							content: "User has approved your plan. You can now start coding.",
						}
					: {
							type: "tool_result",
							tool_use_id: EXIT_PLAN_MODE_TOOL_USE_ID,
							content: "The user doesn't want to proceed with this tool use.",
							is_error: true,
						},
			],
		},
	};
}

function toLines(records: unknown[]): string[] {
	return records.map((record) => JSON.stringify(record));
}

describe("deriveClaudeConversationPlanModeStateFromTranscriptLines", () => {
	it("plan 期间问题待答、尚未批准就死掉 → plan 仍开着（续跑必须回到 plan）", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([permissionModeRecord("plan"), humanUserRecord("plan", "调研一下"), planModeAttachmentRecord()]),
			),
		).toBe("plan_mode_still_open");
	});

	it("ExitPlanMode 获批后立刻开工、还没到下一个人工回合就被回收 → 不在 plan（最后一条模式记录仍是 plan）", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([
					permissionModeRecord("plan"),
					humanUserRecord("plan"),
					exitPlanModeToolUseRecord(),
					exitPlanModeToolResultRecord(true),
				]),
			),
		).toBe("plan_mode_not_open");
	});

	it("ExitPlanMode 被拒 → plan 仍开着", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([
					permissionModeRecord("plan"),
					humanUserRecord("plan"),
					exitPlanModeToolUseRecord(),
					exitPlanModeToolResultRecord(false),
				]),
			),
		).toBe("plan_mode_still_open");
	});

	it("出现 plan_mode_exit 提醒 → 不在 plan", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([permissionModeRecord("plan"), planModeExitAttachmentRecord()]),
			),
		).toBe("plan_mode_not_open");
	});

	it("退出后又重新进入 plan（下一回合的模式记录是 plan）→ plan 仍开着", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([
					permissionModeRecord("plan"),
					exitPlanModeToolUseRecord(),
					exitPlanModeToolResultRecord(true),
					planModeExitAttachmentRecord(),
					permissionModeRecord("bypassPermissions"),
					humanUserRecord("plan", "/plan 再规划一下"),
				]),
			),
		).toBe("plan_mode_still_open");
	});

	it("最后的模式是 bypass / acceptEdits / default → 不在 plan", () => {
		for (const permissionMode of ["bypassPermissions", "acceptEdits", "default"]) {
			expect(
				deriveClaudeConversationPlanModeStateFromTranscriptLines(
					toLines([permissionModeRecord("plan"), permissionModeRecord(permissionMode)]),
				),
			).toBe("plan_mode_not_open");
		}
	});

	it("侧链（subagent）的记录不代表主对话", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(
				toLines([
					permissionModeRecord("plan"),
					{ type: "permission-mode", permissionMode: "bypassPermissions", isSidechain: true },
				]),
			),
		).toBe("plan_mode_still_open");
	});

	it("尾窗里没有任何模式记录 → 问不出结论（null），调用方维持原规则", () => {
		expect(
			deriveClaudeConversationPlanModeStateFromTranscriptLines(toLines([exitPlanModeToolUseRecord()])),
		).toBeNull();
		expect(deriveClaudeConversationPlanModeStateFromTranscriptLines(["not json"])).toBeNull();
	});
});

describe("probeClaudeConversationPlanModeStateBeforeResume", () => {
	it("按原生 session id 读那段对话自己的转录，而不是工作目录里最近的那一段", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, SESSION_A, [permissionModeRecord("plan"), humanUserRecord("plan")]);
		writeTranscript(fixture, SESSION_B, [permissionModeRecord("bypassPermissions")]);

		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: SESSION_A,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBe("plan_mode_still_open");
		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: SESSION_B,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBe("plan_mode_not_open");
	});

	it("没有原生 id 时读 `--continue` 会接上的那一个转录", async () => {
		const fixture = createProbeFixture();
		writeTranscript(fixture, SESSION_A, [permissionModeRecord("plan"), planModeAttachmentRecord()]);

		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: null,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBe("plan_mode_still_open");
	});

	it("最后一条模式记录被大块只读调研结果推离末尾、但仍在尾窗预算内 → 照样读得到", async () => {
		const fixture = createProbeFixture();
		const largeReadResultRecord = {
			type: "user",
			isSidechain: false,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "x".repeat(4096) }],
			},
		};
		const paddingRecordCount = Math.floor(MAX_TRANSCRIPT_TAIL_BYTES_PER_PLAN_MODE_PROBE_FILE / 2 / 4200);
		writeTranscript(fixture, SESSION_A, [
			permissionModeRecord("plan"),
			...Array.from({ length: paddingRecordCount }, () => largeReadResultRecord),
		]);

		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: SESSION_A,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBe("plan_mode_still_open");
	});

	it("没有转录 / 非 claude agent / 非法 session id → null", async () => {
		const fixture = createProbeFixture();
		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: SESSION_A,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBeNull();
		writeTranscript(fixture, SESSION_A, [permissionModeRecord("plan")]);
		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "codex",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: SESSION_A,
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBeNull();
		await expect(
			probeClaudeConversationPlanModeStateBeforeResume({
				agentId: "claude",
				workspacePath: fixture.workspacePath,
				agentNativeConversationSessionId: "../../etc/passwd",
				homeDirectoryPath: fixture.homeDirectoryPath,
			}),
		).resolves.toBeNull();
	});
});
