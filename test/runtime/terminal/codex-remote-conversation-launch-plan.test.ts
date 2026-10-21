import { describe, expect, it } from "vitest";
import {
	buildCodexRemoteConversationResumeTuiArguments,
	prepareCodexRemoteConversationLaunchPlan,
} from "../../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";

describe("Codex 远程恢复的原生权限与 TUI 参数分流", () => {
	it("新建会话保留原生路径，模型值和正文不被误判成子命令", () => {
		expect(prepareCodexRemoteConversationLaunchPlan(["--model", "resume", "实现需求"], "/work")).toBeNull();
		expect(prepareCodexRemoteConversationLaunchPlan(["--", "resume"], "/work")).toBeNull();
	});
	it.each(
		["--remote-auth-token-env", "--local-provider"].flatMap((option) =>
			["分参", "等号"].flatMap((argumentForm) =>
				["子命令前", "子命令后"].flatMap((optionPosition) =>
					["resume", "fork"].map((operation) => ({ option, argumentForm, optionPosition, operation })),
				),
			),
		),
	)(
		"$operation 的 $option（$argumentForm，$optionPosition）保留完整值并正确分流权限",
		({ option, argumentForm, optionPosition, operation }) => {
			const value = option === "--local-provider" ? "ollama" : "ISOLATED_REMOTE_AUTH_TOKEN";
			const optionArguments = argumentForm === "分参" ? [option, value] : [`${option}=${value}`];
			const conversationArguments = [operation, "source-id"];
			const arguments_ = [
				"--sandbox=read-only",
				"--ask-for-approval=never",
				...(optionPosition === "子命令前"
					? [...optionArguments, ...conversationArguments]
					: [...conversationArguments, ...optionArguments]),
				"只回答当前问题",
			];
			const originalArguments = [...arguments_];
			const plan = prepareCodexRemoteConversationLaunchPlan(arguments_, "/work");
			if (!plan) throw new Error("带值选项不应阻止生成恢复或分叉计划");
			expect(plan).toMatchObject({
				operation,
				sourceNativeSessionId: "source-id",
				nativeThreadRequestOverrides: { sandbox: "read-only", approvalPolicy: "never" },
			});
			expect(plan.tuiArgumentsWithoutSessionSelection).toEqual(optionArguments);
			expect(plan.appServerRootArguments).toEqual([]);
			expect(buildCodexRemoteConversationResumeTuiArguments(plan, "confirmed-id")).toEqual([
				...optionArguments,
				"resume",
				"confirmed-id",
				"只回答当前问题",
			]);
			expect(arguments_).toEqual(originalArguments);
		},
	);
	it.each(["--remote-auth-token-env", "--local-provider"])("新建会话的 %s 值不被误认成恢复子命令", (option) => {
		for (const value of [option === "--local-provider" ? "ollama" : "ISOLATED_REMOTE_AUTH_TOKEN", "resume", "fork"]) {
			for (const optionArguments of [[option, value], [`${option}=${value}`]]) {
				const arguments_ = [...optionArguments, "--sandbox=read-only", "新建会话正文"];
				const originalArguments = [...arguments_];
				expect(prepareCodexRemoteConversationLaunchPlan(arguments_, "/work")).toBeNull();
				expect(arguments_).toEqual(originalArguments);
			}
		}
	});
	it("恢复时将 bypass 交给原生请求，保留模型、指令和工作目录", () => {
		const arguments_ = [
			"-c",
			'developer_instructions="原始指令"',
			"--model",
			"gpt-model",
			"-C",
			"/work",
			"--dangerously-bypass-approvals-and-sandbox",
			"resume",
			"native-source-id",
		];
		const original = [...arguments_];
		const plan = prepareCodexRemoteConversationLaunchPlan(arguments_, "/fallback");
		expect(plan).toMatchObject({
			operation: "resume",
			sourceNativeSessionId: "native-source-id",
			workingDirectoryPath: "/work",
			nativeThreadRequestOverrides: { approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-model" },
		});
		if (!plan) throw new Error("应生成恢复计划");
		expect(buildCodexRemoteConversationResumeTuiArguments(plan, "native-source-id")).toEqual([
			"-c",
			'developer_instructions="原始指令"',
			"--model",
			"gpt-model",
			"-C",
			"/work",
			"resume",
			"native-source-id",
		]);
		expect(arguments_).toEqual(original);
	});
	it("只读 fork 不继承源会话权限，启动正文只保留一次", () => {
		const plan = prepareCodexRemoteConversationLaunchPlan(
			["fork", "source-id", "--sandbox=read-only", "-anever", "--no-alt-screen", "只回答这个问题"],
			"/work",
		);
		expect(plan).toMatchObject({
			operation: "fork",
			nativeThreadRequestOverrides: { sandbox: "read-only", approvalPolicy: "never" },
		});
		if (!plan) throw new Error("应生成分叉计划");
		expect(buildCodexRemoteConversationResumeTuiArguments(plan, "new-fork-id")).toEqual([
			"--no-alt-screen",
			"resume",
			"new-fork-id",
			"只回答这个问题",
		]);
	});
	it("权限 TOML 覆盖只经 RPC 消费，保留严格 untrusted 与其他配置", () => {
		const plan = prepareCodexRemoteConversationLaunchPlan(
			[
				"-capproval_policy='untrusted'",
				'--config=sandbox_mode="read-only"',
				"-c",
				'sandbox_workspace_write.writable_roots=["/extra"]',
				"-c",
				'model_reasoning_effort="high"',
				"resume",
				"--last",
				"--include-non-interactive",
			],
			"/work",
		);
		expect(plan).toMatchObject({
			selectsLatestConversation: true,
			includeNonInteractiveConversations: true,
			nativeThreadRequestOverrides: { approvalPolicy: "untrusted", sandbox: "read-only" },
			appServerRootArguments: ["-c", 'model_reasoning_effort="high"'],
		});
		if (!plan) throw new Error("应生成最近会话恢复计划");
		expect(buildCodexRemoteConversationResumeTuiArguments(plan, "selected-id")).toEqual([
			"-c",
			'model_reasoning_effort="high"',
			"resume",
			"selected-id",
		]);
	});
	it.each(["resume", "fork"])("%s 的旧版合法权限配置按原生兼容语义规范化，且不转发给 TUI", (operation) => {
		for (const [configuration, expectedOverrides] of [
			['approval_policy="on-failure"', { approvalPolicy: "on-request" }],
			['approvals_reviewer="guardian_subagent"', { approvalsReviewer: "auto_review" }],
		] as const) {
			const plan = prepareCodexRemoteConversationLaunchPlan(["-c", configuration, operation, "source-id"], "/work");
			if (!plan) throw new Error("应生成原生恢复或分叉计划");
			expect(plan.nativeThreadRequestOverrides).toEqual(expectedOverrides);
			expect(plan.appServerRootArguments).toEqual([]);
			expect(buildCodexRemoteConversationResumeTuiArguments(plan, "confirmed-id")).toEqual([
				"resume",
				"confirmed-id",
			]);
		}
	});
	it("终止符后的旗标字样属于正文，不消耗为权限或寻址参数", () => {
		const plan = prepareCodexRemoteConversationLaunchPlan(
			["resume", "source-id", "--", "--sandbox read-only"],
			"/work",
		);
		if (!plan) throw new Error("应生成恢复计划");
		expect(buildCodexRemoteConversationResumeTuiArguments(plan, "source-id")).toEqual([
			"resume",
			"source-id",
			"--",
			"--sandbox read-only",
		]);
		expect(plan.nativeThreadRequestOverrides).not.toHaveProperty("sandbox");
	});
	it("缺少值、缺少目标与非法权限均明确失败", () => {
		expect(() => prepareCodexRemoteConversationLaunchPlan(["resume", "source-id", "--sandbox"], "/work")).toThrow();
		expect(() => prepareCodexRemoteConversationLaunchPlan(["resume"], "/work")).toThrow();
		expect(() =>
			prepareCodexRemoteConversationLaunchPlan(["resume", "source-id", "-c", 'approval_policy="invalid"'], "/work"),
		).toThrow();
	});
	it.each([true, false])("专用权限旗标优先于配置覆盖，配置在前：%s", (configurationFirst) => {
		const configuration = ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'];
		const flags = ["-a", "on-request", "-s", "read-only"];
		const options = configurationFirst ? [...configuration, ...flags] : [...flags, ...configuration];
		expect(prepareCodexRemoteConversationLaunchPlan([...options, "resume", "source-id"], "/work")).toMatchObject({
			nativeThreadRequestOverrides: { approvalPolicy: "on-request", sandbox: "read-only" },
		});
	});
});
