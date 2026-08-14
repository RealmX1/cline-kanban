// hook payload → 待答决策白名单 payload 的提取：AskUserQuestion 的单选 / 多选 / 多问三形态，
// 权限请求只带工具名与摘要，以及「正文与选项绝不出现在诊断日志字段里」的隐私边界。
// 另含上游分流器 buildAgentRaisedDecisionPayloads 的判定顺序（哪些 hook 该落到哪个提取器、
// 哪些刻意不采集）——它与两个提取器是同一条采集链路，放在一起才锁得住端到端语义。
import { describe, expect, it } from "vitest";

import {
	extractAgentRaisedToolPermissionPayload,
	extractAgentRaisedUserQuestionPayload,
} from "../../../src/commands/agent-raised-decision-payload-extraction";
import { buildAgentRaisedDecisionPayloads } from "../../../src/commands/hooks";

// Claude AskUserQuestion 的工具输入形状（单问）。
const singleQuestionToolInput = {
	questions: [
		{
			question: "数据访问层用哪种方案？",
			header: "数据访问",
			multiSelect: false,
			options: [
				{ label: "自建 SQL", description: "手写 SQL 与迁移脚本" },
				{ label: "用 ORM", description: "模型即 schema" },
			],
		},
	],
};

describe("extractAgentRaisedUserQuestionPayload", () => {
	it("单问 → 结构化选项 + 稳定 optionId + header 渲进正文", () => {
		const payload = extractAgentRaisedUserQuestionPayload({
			toolUseId: "toolu_abc",
			toolInput: singleQuestionToolInput,
		});
		expect(payload).not.toBeNull();
		expect(payload?.decisionSourceId).toBe("toolu_abc");
		expect(payload?.questionMarkdown).toContain("数据访问");
		expect(payload?.questionMarkdown).toContain("数据访问层用哪种方案？");
		expect(payload?.options).toEqual([
			{ optionId: "option-0", label: "自建 SQL", description: "手写 SQL 与迁移脚本" },
			{ optionId: "option-1", label: "用 ORM", description: "模型即 schema" },
		]);
		expect(payload?.multiSelect).toBe(false);
		expect(payload?.allowsFreeformAnswer).toBe(true);
	});

	it("多选如实透传 multiSelect", () => {
		const payload = extractAgentRaisedUserQuestionPayload({
			toolUseId: "toolu_multi",
			toolInput: { questions: [{ ...singleQuestionToolInput.questions[0], multiSelect: true }] },
		});
		expect(payload?.multiSelect).toBe(true);
	});

	it("多问 → 保留有序问题、各自选择模式与选项归属，可逐问结构化作答", () => {
		const payload = extractAgentRaisedUserQuestionPayload({
			toolUseId: "toolu_multi_question",
			toolInput: {
				questions: [
					{ question: "先做哪个？", options: [{ label: "A" }, { label: "B" }] },
					{ question: "要不要加缓存？", header: "缓存", options: [{ label: "要" }, { label: "不要" }] },
				],
			},
		});
		expect(payload?.orderedQuestions).toEqual([
			{
				decisionQuestionId: "question-0",
				headerMarkdown: null,
				questionMarkdown: "先做哪个？",
				selectionMode: "single",
				options: [
					{ optionId: "question-0-option-0", label: "A" },
					{ optionId: "question-0-option-1", label: "B" },
				],
				allowsFreeformAnswer: true,
			},
			{
				decisionQuestionId: "question-1",
				headerMarkdown: "缓存",
				questionMarkdown: "要不要加缓存？",
				selectionMode: "single",
				options: [
					{ optionId: "question-1-option-0", label: "要" },
					{ optionId: "question-1-option-1", label: "不要" },
				],
				allowsFreeformAnswer: true,
			},
		]);
		expect(payload?.questionMarkdown).toContain("先做哪个？");
		expect(payload?.questionMarkdown).toContain("要不要加缓存？");
		// 每个选项都要挂在自己那一问下面，否则扁平化就丢了归属。
		expect(payload?.questionMarkdown).toContain("- A");
		expect(payload?.questionMarkdown).toContain("- 不要");
	});

	it("无 questions / 空数组 / 畸形条目 → 不采集（宁可少采集也不让 hook 投递失败）", () => {
		expect(extractAgentRaisedUserQuestionPayload({ toolUseId: "x", toolInput: null })).toBeNull();
		expect(extractAgentRaisedUserQuestionPayload({ toolUseId: "x", toolInput: {} })).toBeNull();
		expect(extractAgentRaisedUserQuestionPayload({ toolUseId: "x", toolInput: { questions: [] } })).toBeNull();
		expect(
			extractAgentRaisedUserQuestionPayload({ toolUseId: "x", toolInput: { questions: [{ question: "  " }] } }),
		).toBeNull();
	});

	it("缺 tool_use_id 时用问题正文派生一个稳定 id（重发仍能去重）", () => {
		const first = extractAgentRaisedUserQuestionPayload({ toolUseId: null, toolInput: singleQuestionToolInput });
		const second = extractAgentRaisedUserQuestionPayload({ toolUseId: null, toolInput: singleQuestionToolInput });
		expect(first?.decisionSourceId).toBe(second?.decisionSourceId);
		expect(first?.decisionSourceId).toContain("ask-user-question:");
	});

	it("无 label 的选项被跳过，不产出空按钮", () => {
		const payload = extractAgentRaisedUserQuestionPayload({
			toolUseId: "toolu_partial",
			toolInput: {
				questions: [
					{ question: "选一个", options: [{ label: "" }, { description: "只有描述" }, { label: "有效" }] },
				],
			},
		});
		expect(payload?.options).toEqual([{ optionId: "option-0", label: "有效" }]);
	});
});

describe("extractAgentRaisedToolPermissionPayload", () => {
	it("只取工具名与参数摘要——参数正文绝不落盘", () => {
		const payload = extractAgentRaisedToolPermissionPayload({
			toolUseId: "toolu_perm",
			toolName: "Bash",
			toolInputSummary: "Bash: npm test",
		});
		expect(payload).toEqual({
			decisionSourceId: "toolu_perm",
			toolName: "Bash",
			toolInputSummary: "Bash: npm test",
		});
		// 形状上就只有这三个字段，没有任何承载参数正文的位置。
		expect(Object.keys(payload ?? {})).toEqual(["decisionSourceId", "toolName", "toolInputSummary"]);
	});

	it("无工具名 → 不采集", () => {
		expect(
			extractAgentRaisedToolPermissionPayload({ toolUseId: "x", toolName: null, toolInputSummary: "..." }),
		).toBeNull();
		expect(
			extractAgentRaisedToolPermissionPayload({ toolUseId: "x", toolName: "   ", toolInputSummary: null }),
		).toBeNull();
	});

	it("缺 tool_use_id 时用工具名派生稳定 id", () => {
		expect(
			extractAgentRaisedToolPermissionPayload({ toolUseId: null, toolName: "Write", toolInputSummary: null })
				?.decisionSourceId,
		).toBe("tool-permission:Write");
	});
});

describe("buildAgentRaisedDecisionPayloads", () => {
	it("普通工具的 PermissionRequest → 采集成工具授权", () => {
		expect(
			buildAgentRaisedDecisionPayloads(
				{ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "toolu_bash" },
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					toolName: "Bash",
					toolInputSummary: "Bash: rm -rf",
				},
			),
		).toEqual({
			agentRaisedToolPermission: {
				decisionSourceId: "toolu_bash",
				toolName: "Bash",
				toolInputSummary: "Bash: rm -rf",
			},
		});
	});

	// 回归：计划审批对话框同样 fire PermissionRequest（携带 toolName=ExitPlanMode）。若不显式分流，
	// 一次计划审批会被写进决策账本并在会话回收后被当成「工具授权请求」重现——而 store 的 decisionKind
	// 枚举刻意不含 plan_review：计划审批不做 durable carry-forward。
	it("ExitPlanMode 的 PermissionRequest → 一律不采集（计划审批不做 carry-forward）", () => {
		expect(
			buildAgentRaisedDecisionPayloads(
				{ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_use_id: "toolu_plan" },
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					toolName: "ExitPlanMode",
					toolInputSummary: "ExitPlanMode: 计划正文摘要",
				},
			),
		).toEqual({});
	});

	it("ExitPlanMode 经 notification_type=permission_prompt / snake_case 工具名抵达同样不采集", () => {
		expect(
			buildAgentRaisedDecisionPayloads(
				{ notification_type: "permission_prompt", tool_name: "exit_plan_mode" },
				{ source: "claude", notificationType: "permission_prompt", toolName: "exit_plan_mode" },
			),
		).toEqual({});
	});

	// 同一条顺序不变量的另一半：AskUserQuestion 的授权对话也会 fire PermissionRequest，必须落到提问
	// 分支而不是被记成工具授权。
	it("AskUserQuestion 的 PermissionRequest → 落提问分支，不落工具授权", () => {
		const result = buildAgentRaisedDecisionPayloads(
			{
				hook_event_name: "PermissionRequest",
				tool_name: "AskUserQuestion",
				tool_use_id: "toolu_ask",
				tool_input: singleQuestionToolInput,
			},
			{ source: "claude", hookEventName: "PermissionRequest", toolName: "AskUserQuestion" },
		);
		expect(result.agentRaisedToolPermission).toBeUndefined();
		expect(result.agentRaisedUserQuestion?.decisionSourceId).toBe("toolu_ask");
	});

	it("既非等人拍板工具、也非权限请求的 hook → 不采集", () => {
		expect(
			buildAgentRaisedDecisionPayloads(
				{ hook_event_name: "PreToolUse", tool_name: "Read" },
				{ source: "claude", hookEventName: "PreToolUse", toolName: "Read" },
			),
		).toEqual({});
		expect(buildAgentRaisedDecisionPayloads(null, { source: "claude" })).toEqual({});
	});
});
