import { describe, expect, it } from "vitest";
import {
	buildIndependentTaskCreationGenerationContext,
	projectIndependentTaskCreationTranscript,
} from "../../../src/independent-task-creation/conversation-context";

describe("分出独立任务的生成上下文", () => {
	it("Claude 已批准计划的调用正文与成功回执按真人决定保留，并保留原始引用", () => {
		const plan = "批准前须保留的计划正文";
		const approval = "User has approved your plan. You can now start coding.";
		const projected = projectIndependentTaskCreationTranscript(
			"claude",
			[
				{
					type: "assistant",
					timestamp: "2026-01-01T00:00:00Z",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "plan-approval", name: "ExitPlanMode", input: { plan } }],
					},
				},
				{
					type: "user",
					uuid: "approval-message",
					timestamp: "2026-01-01T00:00:01Z",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "plan-approval", content: approval }],
					},
				},
			],
			"claude-transcript",
			[12, 15],
		);
		expect(projected.find((message) => message.role === "assistant")?.text).toContain(plan);
		expect(projected.filter((message) => message.role === "user")).toEqual([
			{
				role: "user",
				text: approval,
				reference: "claude-transcript:15",
				submittedAt: Date.parse("2026-01-01T00:00:01Z"),
				nativeMessageId: "approval-message",
			},
		]);
		const context = buildIndependentTaskCreationGenerationContext({
			beforeSideSession: [],
			afterSideSession: projected,
			userTaskDescription: "落实已批准计划",
		});
		expect(context).toContain(plan);
		expect(context).toContain(approval);
	});

	it.each([
		{ name: "计划尚未回答", includeResult: false },
		{ name: "计划被拒绝", isError: true },
		{ name: "成功回执未匹配计划调用", resultCallId: "unrelated-tool" },
		{ name: "其它普通工具成功", toolName: "Read" },
		{ name: "侧链计划批准", isSidechain: true },
		{ name: "非用户回执", resultRecordType: "assistant" },
	])("不会把 $name 虚构为用户已批准计划", (scenario) => {
		const records = [
			{
				type: "assistant",
				isSidechain: scenario.isSidechain,
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "plan", name: scenario.toolName ?? "ExitPlanMode", input: { plan: "计划" } },
					],
				},
			},
			...(scenario.includeResult === false
				? []
				: [
						{
							type: scenario.resultRecordType ?? "user",
							isSidechain: scenario.isSidechain,
							message: {
								role: scenario.resultRecordType ?? "user",
								content: [
									{
										type: "tool_result",
										tool_use_id: scenario.resultCallId ?? "plan",
										is_error: scenario.isError,
										content: scenario.isError ? "用户未批准" : "用户已批准",
									},
								],
							},
						},
					]),
		];
		expect(
			projectIndependentTaskCreationTranscript("claude", records).filter((message) => message.role === "user"),
		).toEqual([]);
	});

	it("保留重启前已验证而尚未写成工具结果的 Codex 真人答案，不把空答案或 aborted 当真人正文", () => {
		const question = {
			questions: [
				{
					id: "scope",
					question: "选择范围",
					header: "范围",
					options: [
						{ label: "解析器", description: "只处理解析器" },
						{ label: "全部", description: "处理全部" },
					],
				},
			],
		};
		const records = [
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:00Z",
				payload: {
					type: "function_call",
					name: "request_user_input",
					call_id: "verified",
					arguments: JSON.stringify(question),
				},
			},
			{
				type: "retained_context",
				timestamp: "2026-01-01T00:00:01Z",
				payload: {
					type: "verified_answer",
					call_id: "verified",
					questions: [{ question: "选择范围", answer: "解析器" }],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:02Z",
				payload: {
					type: "function_call",
					name: "request_user_input",
					call_id: "empty",
					arguments: JSON.stringify(question),
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:03Z",
				payload: { type: "function_call_output", call_id: "empty", output: '{"answers":{}}' },
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:04Z",
				payload: {
					type: "function_call_output",
					call_id: "empty",
					output: '{"aborted":true,"answers":{"scope":{"answers":["不是有效答案"]}}}',
				},
			},
		];
		const users = projectIndependentTaskCreationTranscript("codex", records).filter(
			(message) => message.role === "user",
		);
		expect(users).toHaveLength(1);
		expect(users[0]?.text).toContain("解析器");
		expect(users[0]?.reference).toBe("transcript:2");
	});
	it("前段保留全部用户要求和最后回答，后段完整保留正文并只引用工具", () => {
		const context = buildIndependentTaskCreationGenerationContext({
			beforeSideSession: [
				{ role: "user", text: "原始需求", reference: "parent:1" },
				{ role: "assistant", text: "过时回答", reference: "parent:2" },
				{ role: "user", text: "不要自动提交", reference: "parent:3" },
				{ role: "assistant", text: "最后回答", reference: "parent:4" },
			],
			afterSideSession: [
				{ role: "user", text: "实现侧线目标", reference: "side:1" },
				{ role: "assistant", text: "讨论方案", reference: "side:2" },
				{ role: "tool_reference", text: "读取文件", reference: "side:3" },
			],
			userTaskDescription: "只分出解析器",
		});
		expect(context).toContain("原始需求");
		expect(context).toContain("不要自动提交");
		expect(context).not.toContain("过时回答");
		expect(context).toContain("最后回答");
		expect(context).toContain("讨论方案");
		expect(context).toContain("side:3");
		expect(context).toContain("只分出解析器");
	});

	it("保留 Codex 真人问答答案，排除注入和内部推理，工具结果正文不进入模型输入", () => {
		const projected = projectIndependentTaskCreationTranscript("codex", [
			{
				isSidechain: true,
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "其他会话的正文" }] },
			},
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "用户原话" }] },
			},
			{ type: "response_item", payload: { type: "reasoning", summary: [{ text: "内部推理" }] } },
			{
				type: "response_item",
				payload: {
					type: "function_call",
					name: "request_user_input",
					call_id: "q1",
					arguments: JSON.stringify({ questions: [{ id: "mode", question: "需要哪种模式？" }] }),
				},
			},
			{
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: "q1",
					output: JSON.stringify({ answers: { mode: { answers: ["只读"] } } }),
				},
			},
			{
				type: "response_item",
				payload: { type: "function_call_output", call_id: "shell1", output: "大量工具结果正文" },
			},
		]);
		const text = JSON.stringify(projected);
		expect(text).toContain("用户原话");
		expect(text).toContain("需要哪种模式");
		expect(text).toContain("只读");
		expect(text).not.toContain("内部推理");
		expect(text).not.toContain("其他会话的正文");
		expect(text).not.toContain("大量工具结果正文");
		expect(projected.some((message) => message.role === "tool_reference")).toBe(true);
	});
});
