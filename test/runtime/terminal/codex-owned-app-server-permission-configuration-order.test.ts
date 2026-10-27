import { describe, expect, it } from "vitest";
import { prepareCodexRemoteConversationLaunchPlan } from "../../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";
import {
	inspectCodexNativeSessionControlHostArguments,
	prepareCodexNativeSessionControlHostLaunch,
} from "../../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";

const launchOperations = ["new", "resume", "fork"] as const;
function ownedHostArguments(operation: (typeof launchOperations)[number], arguments_: string[]) {
	if (operation === "new") return inspectCodexNativeSessionControlHostArguments(arguments_).appServerRootArguments;
	const plan = prepareCodexRemoteConversationLaunchPlan([...arguments_, operation, "source-id"], "/work");
	if (!plan) throw new Error("恢复或分叉应生成独享宿主计划。");
	return plan.appServerRootArguments;
}

describe("独享 Codex 宿主权限配置的原生顺序与参数形态", () => {
	it.each(launchOperations)("%s 的有效 untrusted 策略明确拒绝受管启动，原 argv 保持原样", async (operation) => {
		for (const permissionArguments of [
			["-a", "untrusted"],
			["-capproval_policy=untrusted"],
			["-auntrusted", "-c", 'approval_policy="never"'],
		]) {
			const arguments_ = [...permissionArguments, ...(operation === "new" ? [] : [operation, "source-id"])];
			const originalArguments = [...arguments_];
			expect(inspectCodexNativeSessionControlHostArguments(arguments_).managesOwnHost).toBe(false);
			await expect(
				prepareCodexNativeSessionControlHostLaunch({
					binary: "/不会探测的原生二进制",
					arguments: arguments_,
					workingDirectoryPath: "/不会创建的启动目录",
					environment: {},
					workspaceId: "isolated-permission-workspace",
					conversationSessionId: "isolated-permission-session",
					runtimeSessionIncarnationId: "isolated-permission-incarnation",
				}),
			).rejects.toThrow("无法为受管宿主提供 untrusted 默认审批策略");
			expect(arguments_).toEqual(originalArguments);
		}
	});
	it.each(launchOperations)("%s 的后项明确非 untrusted 选择仍可使用受管宿主", (operation) => {
		for (const permissionArguments of [
			["-auntrusted", "-a=never"],
			["-capproval_policy=untrusted", "-c", 'approval_policy="never"'],
			["-capproval_policy=untrusted", "-a=never"],
			["-capproval_policy=untrusted", "--dangerously-bypass-approvals-and-sandbox"],
		]) {
			const arguments_ = [...permissionArguments, ...(operation === "new" ? [] : [operation, "source-id"])];
			expect(inspectCodexNativeSessionControlHostArguments(arguments_).managesOwnHost).toBe(true);
		}
	});
	it.each(launchOperations)("%s 不把原生加载器已拒绝的 untrusted 配置透传给宿主", (operation) => {
		for (const configuration of ["-capproval_policy=untrusted", '-c=approval_policy="untrusted"']) {
			expect(ownedHostArguments(operation, [configuration])).toEqual([]);
		}
	});
	it.each(launchOperations)("%s 保持整体权限配置与后续点路径覆盖的顺序", (operation) => {
		const configurationArguments = [
			"-c",
			"approval_policy={ granular = { sandbox_approval = true } }",
			"-c",
			"approval_policy.granular.sandbox_approval=false",
		];
		const hostArguments = ownedHostArguments(operation, configurationArguments);
		expect(hostArguments.filter((argument) => argument !== "-c").map((argument) => argument.split("=")[0])).toEqual([
			"approval_policy",
			"approval_policy.granular.sandbox_approval",
		]);
	});
	it.each(launchOperations)("%s 支持带分隔等号的短选项且不重复透传配置", (operation) => {
		expect(ownedHostArguments(operation, ['-c=approval_policy="never"'])).toEqual(["-c", 'approval_policy="never"']);
		expect(ownedHostArguments(operation, ["-s=read-only", "-a=never", '-c=approval_policy="on-request"'])).toEqual([
			"-c",
			'approval_policy="on-request"',
			"-c",
			'sandbox_mode="read-only"',
			"-c",
			'approval_policy="never"',
		]);
	});
	it.each(launchOperations)("%s 的专用权限旗标始终在配置覆盖之后生效", (operation) => {
		const configuration = ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'];
		const flags = ["-a=on-request", "-s=read-only"];
		for (const arguments_ of [
			[...configuration, ...flags],
			[...flags, ...configuration],
		]) {
			expect(ownedHostArguments(operation, arguments_).slice(-4)).toEqual([
				"-c",
				'approval_policy="on-request"',
				"-c",
				'sandbox_mode="read-only"',
			]);
		}
	});
});
