import { describe, expect, it } from "vitest";
import {
	inspectCodexNativeSessionControlHostArguments,
	prepareCodexNativeSessionControlHostLaunch,
} from "../../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";

describe("Codex 独享控制宿主的配置与原生 argv 边界", () => {
	it("只向 server 复制配置层，保留模型/权限和 resume 的原生语义", () => {
		const arguments_ = [
			"-c",
			"hooks.UserPromptSubmit=[]",
			'--config=developer_instructions="原始逐字指令"',
			"--enable",
			"hooks",
			"--model",
			"gpt-model",
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"never",
			"resume",
			"native-session-id",
		];
		const original = [...arguments_];
		expect(inspectCodexNativeSessionControlHostArguments(arguments_)).toEqual({
			managesOwnHost: true,
			appServerRootArguments: [
				"-c",
				"hooks.UserPromptSubmit=[]",
				'--config=developer_instructions="原始逐字指令"',
				"--enable",
				"hooks",
			],
		});
		expect(arguments_).toEqual(original);
	});
	it.each([["--remote", "unix:///explicit.sock"], ["--remote=ws://localhost:1234"], ["--no-daemon"]])(
		"不覆盖显式宿主选择 %j",
		(...arguments_) => {
			expect(inspectCodexNativeSessionControlHostArguments(arguments_).managesOwnHost).toBe(false);
		},
	);
	it.each([
		["-p", "task-profile"],
		["--profile", "task-profile"],
		["--profile=task-profile"],
		["-ptask-profile"],
		["-p=task-profile"],
	])("显式 profile 保留原生启动，不探测或分配受控宿主 %j", async (...arguments_) => {
		const original = [...arguments_];
		expect(inspectCodexNativeSessionControlHostArguments(arguments_)).toEqual({
			managesOwnHost: false,
			appServerRootArguments: [],
		});
		expect(
			await prepareCodexNativeSessionControlHostLaunch({
				binary: "/不会执行的原生二进制",
				arguments: arguments_,
				workingDirectoryPath: "/不会创建的启动目录",
				environment: {},
				workspaceId: "isolated-workspace",
				conversationSessionId: "isolated-session",
				runtimeSessionIncarnationId: "isolated-incarnation",
			}),
		).toBeNull();
		expect(arguments_).toEqual(original);
	});
	it("配置值、模型值与终止符后的 profile 字样不改变宿主选择", () => {
		expect(
			inspectCodexNativeSessionControlHostArguments([
				"--config",
				"--profile",
				"--model",
				"-ptask-profile",
				"--",
				"--profile=prompt-text",
			]),
		).toEqual({ managesOwnHost: true, appServerRootArguments: ["--config", "--profile"] });
	});
	it("配置值和终止符后的 prompt 不被当成宿主开关", () => {
		expect(inspectCodexNativeSessionControlHostArguments(["--config", "--remote", "--", "--no-daemon"])).toEqual({
			managesOwnHost: true,
			appServerRootArguments: ["--config", "--remote"],
		});
	});
});
