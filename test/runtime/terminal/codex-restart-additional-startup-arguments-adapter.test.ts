import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { createTempDir } from "../../utilities/temp-dir";

const home = createTempDir("kanban-codex-restart-arguments-");
afterEach(() => vi.unstubAllEnvs());
afterAll(() => home.cleanup());

describe("Codex adapter 的单次重启参数优先级", () => {
	it("本次补传覆盖 profile 生成的模型、完整权限和推理配置，不修改 profile", async () => {
		vi.stubEnv("HOME", home.path);
		vi.stubEnv("CODEX_HOME", home.path);
		vi.stubEnv("CODEX_SQLITE_HOME", home.path);
		const profileFields = {
			[JSON.stringify(["config.toml", "approval_policy"])]: { value: "never" },
			[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "danger-full-access" },
			[JSON.stringify(["config.toml", "model_reasoning_effort"])]: { value: "high" },
		};
		const originalProfileFields = structuredClone(profileFields);
		const launch = await prepareAgentLaunch({
			taskId: "isolated-profile-restart",
			agentId: "codex",
			args: [],
			cwd: home.path,
			prompt: "",
			resumeFromTrash: true,
			codexConfigurationProfileLaunchFields: profileFields,
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "profile-model" },
			observedAgentNativeConversationSessionResumeAddressing: {
				sourceAgentId: "codex",
				sourceSessionId: "bound-id",
				sourceSessionReuseMode: "resume_existing_session",
			},
			additionalAgentStartupArgumentsForThisRestart: [
				"--model=debug-model",
				"--sandbox=read-only",
				"-c",
				'approval_policy="on-request"',
				"-c",
				'model_reasoning_effort="low"',
			],
		});
		expect(launch.args).toEqual(
			expect.arrayContaining([
				"--model=debug-model",
				"--sandbox=read-only",
				'approval_policy="on-request"',
				'model_reasoning_effort="low"',
				"resume",
				"bound-id",
			]),
		);
		for (const defaultArgument of [
			"profile-model",
			'sandbox_mode="danger-full-access"',
			'approval_policy="never"',
			'model_reasoning_effort="high"',
		])
			expect(launch.args).not.toContain(defaultArgument);
		expect(profileFields).toEqual(originalProfileFields);
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
