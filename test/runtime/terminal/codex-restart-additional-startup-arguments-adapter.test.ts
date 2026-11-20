import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { removeCodexConversationSelectionAndPromptFromStartupArguments } from "../../../src/terminal/codex-additional-startup-arguments-for-restart";
import { createTempDir } from "../../utilities/temp-dir";

const home = createTempDir("kanban-codex-restart-arguments-");
afterEach(() => vi.unstubAllEnvs());
afterAll(() => home.cleanup());

describe("Codex adapter 的单次重启参数优先级", () => {
	it.each([
		["--", "历史首条需求"],
		["--", "resume", "old-id", "历史首条需求"],
		["--image", "/isolated/first.png"],
	])("自动恢复清理启动内容后，真实 adapter 仅续接当前身份：%j", async (...initialContentArguments) => {
		vi.stubEnv("HOME", home.path);
		vi.stubEnv("CODEX_HOME", home.path);
		vi.stubEnv("CODEX_SQLITE_HOME", home.path);
		const launch = await prepareAgentLaunch({
			taskId: "isolated-sanitized-recovery",
			agentId: "codex",
			args: [],
			cwd: home.path,
			prompt: "",
			resumePriorAgentConversationWithoutResendingPrompt: true,
			observedAgentNativeConversationSessionResumeAddressing: {
				sourceAgentId: "codex",
				sourceSessionId: "bound-id",
				sourceSessionReuseMode: "resume_existing_session",
			},
			additionalAgentStartupArgumentsForThisRestart: removeCodexConversationSelectionAndPromptFromStartupArguments([
				"--model=retained-model",
				"--sandbox=read-only",
				...initialContentArguments,
			]),
		});
		expect(launch.args).toEqual(
			expect.arrayContaining(["resume", "bound-id", "--model=retained-model", "--sandbox=read-only"]),
		);
		for (const initialContentArgument of initialContentArguments)
			if (initialContentArgument !== "resume") expect(launch.args).not.toContain(initialContentArgument);
		expect(launch.args.filter((argument) => argument === "resume")).toHaveLength(1);
		expect(launch.deferredStartupPromptText ?? null).toBeNull();
	});
	it("自动 -C、模型、权限与系统配置均可在归一化前覆盖，默认保留当前原生 ID", async () => {
		vi.stubEnv("HOME", home.path);
		vi.stubEnv("CODEX_HOME", home.path);
		vi.stubEnv("CODEX_SQLITE_HOME", home.path);
		const launch = await prepareAgentLaunch({
			taskId: "isolated-restart",
			agentId: "codex",
			args: [],
			cwd: home.path,
			prompt: "",
			resumeFromTrash: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "default-model" },
			observedAgentNativeConversationSessionResumeAddressing: {
				sourceAgentId: "codex",
				sourceSessionId: "bound-id",
				sourceSessionReuseMode: "resume_existing_session",
			},
			additionalAgentStartupArgumentsForThisRestart: [
				"--cd",
				"/explicit path",
				"-mdebug",
				"-c",
				"approval_policy=never",
				"--sandbox=read-only",
				"-c",
				"developer_instructions=debug",
				"--future-debug",
			],
		});
		expect(launch.args).toEqual(
			expect.arrayContaining([
				"resume",
				"bound-id",
				"--cd",
				"/explicit path",
				"-mdebug",
				"approval_policy=never",
				"--sandbox=read-only",
				"developer_instructions=debug",
				"--future-debug",
			]),
		);
		expect(launch.args).not.toContain("-C");
		expect(launch.args).not.toContain("default-model");
		expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(launch.args.indexOf("approval_policy=never")).toBeLessThan(launch.args.indexOf("resume"));
	});
});
