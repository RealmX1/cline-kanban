import { describe, expect, it } from "vitest";
import {
	captureAgentSessionForkReplayLaunchArguments,
	isSameAgentSessionForkReplayLaunchArguments,
} from "../../../src/terminal/agent-session-fork-replay-launch-arguments-capture";

describe("captureAgentSessionForkReplayLaunchArguments", () => {
	it("摘下 claude argv 里的 model / append-system-prompt / settings 三项", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: [
				"--permission-mode",
				"acceptEdits",
				"--model",
				"default",
				"--settings",
				"/Users/someone/.cline/kanban/hooks/claude/settings.json",
				"--append-system-prompt",
				"This is an exploratory conversation.\nSecond line.",
				"初始 prompt",
			],
			capturedAt: 1700000000000,
		});
		expect(captured).toEqual({
			sourceAgentId: "claude",
			modelArgumentLiteral: "default",
			appendSystemPromptText: "This is an exploratory conversation.\nSecond line.",
			settingsFilePath: "/Users/someone/.cline/kanban/hooks/claude/settings.json",
			capturedAt: 1700000000000,
		});
	});

	it("保留 model 的字面别名而不是任何解析结果", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--model", "default"],
			capturedAt: 1,
		});
		// `default` 是随上游换代漂移的浮动别名：存字面值，fork 时原样传回去才跟得上主会话。
		expect(captured?.modelArgumentLiteral).toBe("default");
	});

	it("append-system-prompt 的内部空白与换行逐字保留（cache 前缀必须字节一致）", () => {
		const promptWithAwkwardWhitespace = "line one\n\n   indented   двойной  пробел\ttab";
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--append-system-prompt", promptWithAwkwardWhitespace],
			capturedAt: 1,
		});
		expect(captured?.appendSystemPromptText).toBe(promptWithAwkwardWhitespace);
	});

	it("同时接受等号式写法", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--model=opus", "--settings=/tmp/settings.json"],
			capturedAt: 1,
		});
		expect(captured?.modelArgumentLiteral).toBe("opus");
		expect(captured?.settingsFilePath).toBe("/tmp/settings.json");
	});

	it("认 -m 短选项，并以最后一次出现为准", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["-m", "sonnet", "--model", "opus"],
			capturedAt: 1,
		});
		expect(captured?.modelArgumentLiteral).toBe("opus");
	});

	it("值以 - 开头也逐字保留（markdown 列表起头的 append-system-prompt 是合法正文）", () => {
		const promptStartingWithDash = "- Be concise\n- Preserve user intent";
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--append-system-prompt", promptStartingWithDash, "--model", "default"],
			capturedAt: 1,
		});
		// 按值的形状判边界会把整段 prompt 丢成 null，fork 前缀对不上 ⇒ prompt cache 静默全 miss。
		expect(captured?.appendSystemPromptText).toBe(promptStartingWithDash);
		expect(captured?.modelArgumentLiteral).toBe("default");
	});

	it("形似选项的 prompt 正文被当作值消费掉，不再污染后续的选项匹配", () => {
		const promptLookingLikeAnOption = "--model=opus 是一个提示词正文";
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--append-system-prompt", promptLookingLikeAnOption, "--settings", "/tmp/settings.json"],
			capturedAt: 1,
		});
		expect(captured?.appendSystemPromptText).toBe(promptLookingLikeAnOption);
		expect(captured?.modelArgumentLiteral).toBeNull();
		expect(captured?.settingsFilePath).toBe("/tmp/settings.json");
	});

	it("必须带值的选项后面那个 token 无条件是值，哪怕它本身形似选项", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--model", "--settings", "/tmp/settings.json"],
			capturedAt: 1,
		});
		// `--model` 是 required-value 选项：CLI 也会把 `--settings` 吃成它的值，快照如实记录同一口径；
		// 值 token 被消费后 `/tmp/settings.json` 只是个裸参数，不构成 settings 选项。
		expect(captured?.modelArgumentLiteral).toBe("--settings");
		expect(captured?.settingsFilePath).toBeNull();
	});

	it("选项落在 argv 末尾、没有后继 token 时算这次出现无值", () => {
		const captured = captureAgentSessionForkReplayLaunchArguments({
			agentId: "claude",
			launchArguments: ["--settings", "/tmp/settings.json", "--model"],
			capturedAt: 1,
		});
		expect(captured?.modelArgumentLiteral).toBeNull();
		expect(captured?.settingsFilePath).toBe("/tmp/settings.json");
	});

	it("尚未接入的 agent 一律不快照", () => {
		expect(
			captureAgentSessionForkReplayLaunchArguments({
				agentId: "codex",
				launchArguments: ["--model", "gpt-5"],
				capturedAt: 1,
			}),
		).toBeNull();
	});

	it("三项全缺时返回 null（没有值得记的东西）", () => {
		expect(
			captureAgentSessionForkReplayLaunchArguments({
				agentId: "claude",
				launchArguments: ["--permission-mode", "acceptEdits"],
				capturedAt: 1,
			}),
		).toBeNull();
	});
});

describe("isSameAgentSessionForkReplayLaunchArguments", () => {
	const base = {
		sourceAgentId: "claude",
		modelArgumentLiteral: "default",
		appendSystemPromptText: "prompt",
		settingsFilePath: "/tmp/settings.json",
		capturedAt: 1,
	};

	it("只比语义字段，capturedAt 变化不算变化", () => {
		expect(isSameAgentSessionForkReplayLaunchArguments(base, { ...base, capturedAt: 999 })).toBe(true);
	});

	it("prompt 文案变了就是变了", () => {
		expect(
			isSameAgentSessionForkReplayLaunchArguments(base, { ...base, appendSystemPromptText: "prompt 改版" }),
		).toBe(false);
	});

	it("两侧都缺算相同，一侧缺算不同", () => {
		expect(isSameAgentSessionForkReplayLaunchArguments(null, null)).toBe(true);
		expect(isSameAgentSessionForkReplayLaunchArguments(null, base)).toBe(false);
	});
});
