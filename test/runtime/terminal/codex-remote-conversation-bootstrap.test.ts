import { describe, expect, it, vi } from "vitest";
import { bootstrapCodexRemoteConversationBeforeTuiAttach } from "../../../src/codex-native-session-control-host/codex-remote-conversation-bootstrap";
import { prepareCodexRemoteConversationLaunchPlan } from "../../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";

const readOnlyResponse = {
	thread: { id: "source-id", path: "/history/source.jsonl", cwd: "/work" },
	approvalPolicy: "never",
	sandbox: { type: "readOnly", networkAccess: false },
};
function plan(arguments_: string[]) {
	const result = prepareCodexRemoteConversationLaunchPlan(arguments_, "/work");
	if (!result) throw new Error("应生成原生恢复计划");
	return result;
}

describe("远程 TUI 接入前的原生恢复握手", () => {
	it("普通恢复仅请求一次，核对有效权限后才返回可启动参数", async () => {
		const request = vi.fn().mockResolvedValue(readOnlyResponse);
		const result = await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan(["--sandbox", "read-only", "--ask-for-approval", "never", "resume", "source-id"]),
		);
		expect(request).toHaveBeenCalledExactlyOnceWith("thread/resume", {
			threadId: "source-id",
			cwd: "/work",
			excludeTurns: true,
			sandbox: "read-only",
			approvalPolicy: "never",
		});
		expect(result).toMatchObject({ nativeSessionId: "source-id", tuiArguments: ["resume", "source-id"] });
	});
	it("已加载 thread 忽略 resume 覆盖时使用 settings/update，不能静默接受高权限", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ ...readOnlyResponse, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ ...readOnlyResponse, approvalPolicy: "untrusted" });
		await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan(["--sandbox", "read-only", "--ask-for-approval", "untrusted", "resume", "source-id"]),
		);
		expect(request.mock.calls.map(([method]) => method)).toEqual([
			"thread/resume",
			"thread/settings/update",
			"thread/resume",
		]);
		expect(request.mock.calls[1][1]).toMatchObject({
			threadId: "source-id",
			approvalPolicy: "untrusted",
			sandboxPolicy: { type: "readOnly" },
		});
		expect(request.mock.calls[2][1]).toEqual({ threadId: "source-id", excludeTurns: true });
	});
	it("旧版配置发送原生规范值，匹配有效权限后才允许 TUI 接入", async () => {
		const request = vi.fn().mockResolvedValue({
			...readOnlyResponse,
			approvalPolicy: "on-request",
			approvalsReviewer: "auto_review",
		});
		const result = await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan([
				"-c",
				'approval_policy="on-failure"',
				"-c",
				'approvals_reviewer="guardian_subagent"',
				"resume",
				"source-id",
			]),
		);
		expect(request).toHaveBeenCalledExactlyOnceWith("thread/resume", {
			threadId: "source-id",
			cwd: "/work",
			excludeTurns: true,
			approvalPolicy: "on-request",
			approvalsReviewer: "auto_review",
		});
		expect(result.effectiveApprovalPolicy).toBe("on-request");
		expect(result.tuiArguments).toEqual(["resume", "source-id"]);
	});
	it("旧版 on-failure 响应进入权限纠正，读回匹配后才允许 TUI 接入", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				...readOnlyResponse,
				approvalPolicy: "on-failure",
				approvalsReviewer: "guardian_subagent",
			})
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ ...readOnlyResponse, approvalsReviewer: "auto_review" });
		const result = await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan(["-a", "never", "-c", 'approvals_reviewer="auto_review"', "resume", "source-id"]),
		);
		expect(request.mock.calls).toEqual([
			[
				"thread/resume",
				{
					threadId: "source-id",
					cwd: "/work",
					excludeTurns: true,
					approvalPolicy: "never",
					approvalsReviewer: "auto_review",
				},
			],
			[
				"thread/settings/update",
				{
					threadId: "source-id",
					approvalPolicy: "never",
					approvalsReviewer: "auto_review",
					sandboxPolicy: { type: "readOnly", networkAccess: false },
				},
			],
			["thread/resume", { threadId: "source-id", excludeTurns: true }],
		]);
		expect(result.effectiveApprovalPolicy).toBe("never");
	});
	it("旧策略或旧 reviewer 纠正后仍不匹配时停止，不把兼容值视为已获所需权限", async () => {
		for (const uncorrectedPermissions of [
			{ approvalPolicy: "on-failure", approvalsReviewer: "auto_review" },
			{ approvalPolicy: "never", approvalsReviewer: "guardian_subagent" },
		]) {
			const request = vi.fn().mockResolvedValue({ ...readOnlyResponse, ...uncorrectedPermissions });
			await expect(
				bootstrapCodexRemoteConversationBeforeTuiAttach(
					{ request },
					plan(["-a", "never", "-c", 'approvals_reviewer="auto_review"', "resume", "source-id"]),
				),
			).rejects.toThrow("Codex 有效权限与任务要求不一致，未启动 TUI 或投递正文。");
			expect(request.mock.calls.map(([method]) => method)).toEqual([
				"thread/resume",
				"thread/settings/update",
				"thread/resume",
			]);
		}
	});
	it("只读 fork 在原生请求中设置限制，再按新 ID 接入且保留唯一正文", async () => {
		const request = vi
			.fn()
			.mockResolvedValue({ ...readOnlyResponse, thread: { ...readOnlyResponse.thread, id: "fork-id" } });
		const result = await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan(["--sandbox", "read-only", "-a", "never", "fork", "source-id", "只回答问题"]),
		);
		expect(request.mock.calls[0]).toEqual([
			"thread/fork",
			{
				threadId: "source-id",
				cwd: "/work",
				excludeTurns: true,
				deferGoalContinuation: true,
				sandbox: "read-only",
				approvalPolicy: "never",
			},
		]);
		expect(result.tuiArguments).toEqual(["resume", "fork-id", "只回答问题"]);
	});
	it("latest 使用原生 cwd/provider/来源过滤，DB 未命中时允许原生扫描修复", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ config: { model_provider: "configured-provider" } })
			.mockResolvedValueOnce({ data: [], nextCursor: null })
			.mockResolvedValueOnce({ data: [{ id: "source-id" }], nextCursor: null })
			.mockResolvedValueOnce(readOnlyResponse);
		await bootstrapCodexRemoteConversationBeforeTuiAttach(
			{ request },
			plan(["resume", "--last", "--include-non-interactive"]),
		);
		expect(request.mock.calls[1][1]).toMatchObject({
			cwd: "/work",
			sortKey: "updated_at",
			modelProviders: ["configured-provider"],
			sourceKinds: ["cli", "vscode", "exec", "appServer"],
			useStateDbOnly: true,
		});
		expect(request.mock.calls[2][1]).not.toHaveProperty("useStateDbOnly");
		expect(request.mock.calls[3][1]).toMatchObject({ threadId: "source-id" });
	});
	it.each([
		{ providerCaseDescription: "显式 null", nativeConfiguration: { model_provider: null } },
		{ providerCaseDescription: "字段缺省", nativeConfiguration: {} },
	])(
		"latest 在 provider 为 $providerCaseDescription 时按 openai 过滤并恢复原会话",
		async ({ nativeConfiguration }) => {
			const request = vi
				.fn()
				.mockResolvedValueOnce({ config: nativeConfiguration })
				.mockResolvedValueOnce({ data: [{ id: "source-id" }], nextCursor: null })
				.mockResolvedValueOnce(readOnlyResponse);
			const result = await bootstrapCodexRemoteConversationBeforeTuiAttach({ request }, plan(["resume", "--last"]));
			expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read", "thread/list", "thread/resume"]);
			expect(request.mock.calls[1][1]).toMatchObject({
				cwd: "/work",
				modelProviders: ["openai"],
				sourceKinds: ["cli", "vscode"],
				useStateDbOnly: true,
			});
			expect(request.mock.calls[2][1]).toMatchObject({ threadId: "source-id" });
			expect(result.tuiArguments).toEqual(["resume", "source-id"]);
		},
	);
	it.each([{ model_provider: 42 }, { model_provider: false }, { model_provider: {} }, { model_provider: [] }])(
		"latest 拒绝非法 provider 类型（$model_provider），不查询或恢复历史",
		async (nativeConfiguration) => {
			const request = vi.fn().mockResolvedValue({ config: nativeConfiguration });
			await expect(
				bootstrapCodexRemoteConversationBeforeTuiAttach({ request }, plan(["resume", "--last"])),
			).rejects.toThrow(/model_provider/u);
			expect(request).toHaveBeenCalledExactlyOnceWith("config/read", { includeLayers: false, cwd: "/work" });
		},
	);
	it("拒绝错误身份与无法兑现的权限，不发起模型回合", async () => {
		const input = plan(["--sandbox", "read-only", "resume", "source-id"]);
		const wrongIdentity = {
			request: vi.fn().mockResolvedValue({ ...readOnlyResponse, thread: { id: "another-id" } }),
		};
		await expect(bootstrapCodexRemoteConversationBeforeTuiAttach(wrongIdentity, input)).rejects.toThrow();
		const widened = {
			request: vi.fn().mockResolvedValue({ ...readOnlyResponse, sandbox: { type: "dangerFullAccess" } }),
		};
		await expect(bootstrapCodexRemoteConversationBeforeTuiAttach(widened, input)).rejects.toThrow(/权限/u);
		expect(widened.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
	});
	it("fork 不盲目重试，latest 无候选不创建空会话", async () => {
		const failed = { request: vi.fn().mockRejectedValue(new Error("请求超时")) };
		await expect(
			bootstrapCodexRemoteConversationBeforeTuiAttach(failed, plan(["fork", "source-id"])),
		).rejects.toThrow("请求超时");
		expect(failed.request).toHaveBeenCalledTimes(1);
		const noCandidate = {
			request: vi.fn().mockResolvedValueOnce({ config: {} }).mockResolvedValue({ data: [], nextCursor: null }),
		};
		await expect(
			bootstrapCodexRemoteConversationBeforeTuiAttach(noCandidate, plan(["resume", "--last"])),
		).rejects.toThrow(/会话/u);
		expect(noCandidate.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
	});
});
