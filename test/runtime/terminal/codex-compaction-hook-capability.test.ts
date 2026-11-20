import { describe, expect, it } from "vitest";
import {
	configureCodexHooks,
	supportsVerifiedCodexAutomaticCompactionPhaseHooks,
} from "../../../src/terminal/codex-hook-config";

describe("自动压缩阶段 hook 的保守启用", () => {
	it("没有实际能力验收时仍使用旧 hook 集，不授予开始信号", () => {
		const args: string[] = [];
		expect(configureCodexHooks(args)).toBe(false);
		expect(args.some((argument) => argument.startsWith("hooks.PreCompact="))).toBe(false);
		expect(args.some((argument) => argument.startsWith("hooks.PostCompact="))).toBe(true);
	});
	it("经原生探针验收的能力配置同时含开始、完成与信任项", () => {
		const args: string[] = [];
		expect(configureCodexHooks(args, true)).toBe(true);
		expect(
			args.some(
				(argument) =>
					argument.startsWith("hooks.PreCompact=") &&
					argument.includes("main_agent_conversation_context_compaction_started"),
			),
		).toBe(true);
		expect(
			args.some((argument) => argument.startsWith("hooks.state=") && argument.includes(":pre_compact:0:0")),
		).toBe(true);
	});
	it.each(["hooks.PreCompact", "hooks.PostCompact", "hooks.state"])("用户覆盖 %s 时不启用新策略", (key) => {
		const customOverride = `${key}=[]`;
		const args = ["-c", customOverride];
		expect(configureCodexHooks(args, true)).toBe(false);
		expect(args).toContain(customOverride);
		if (key !== "hooks.PreCompact")
			expect(args.some((argument) => argument.startsWith("hooks.PreCompact="))).toBe(false);
	});
	it("合并受管目录的整表 hooks.state，保留用户禁用且只签发实际注入的 hook", () => {
		const args = [
			'--config=hooks.state={"/source/config.toml:stop:0:0"={trusted_hash="sha256:user",enabled=false}}',
			"-c",
			'hooks.PermissionRequest=[{hooks=[{type="command",command="user-owned"}]}]',
		];
		configureCodexHooks(args);
		const state = args.find((argument) => argument.startsWith("--config=hooks.state="));
		expect(state).toContain('"/source/config.toml:stop:0:0"');
		expect(state).toMatch(/"enabled"\s*=\s*false/);
		expect(state).toContain("/<session-flags>/config.toml:session_start:0:0");
		expect(state).toContain("/<session-flags>/config.toml:stop:0:0");
		expect(state).not.toContain("/<session-flags>/config.toml:permission_request:0:0");
	});
	it("未验收的实际二进制不能按版本号大小猜测能力", async () => {
		expect(await supportsVerifiedCodexAutomaticCompactionPhaseHooks(process.execPath, process.env)).toBe(false);
		expect(
			await supportsVerifiedCodexAutomaticCompactionPhaseHooks("/missing-codex-capability-binary", process.env),
		).toBe(false);
	});
});
