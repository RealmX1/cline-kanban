import { expect, it } from "vitest";
import { normalizeCodexConfigOverridesBeforeSubcommand } from "../../../src/terminal/codex-hook-config";

it("配置搬到根参数区时保留覆盖顺序、紧凑写法和多行指令字面值", () => {
	const instructions = 'developer_instructions="line one\\nline two with resume and fork"';
	const args = [
		"--model",
		"resume",
		'--config=model="first"',
		"fork",
		"native-id",
		'-cmodel="second"',
		"-c",
		instructions,
	];
	normalizeCodexConfigOverridesBeforeSubcommand(args);
	expect(args).toEqual([
		'--config=model="first"',
		'-cmodel="second"',
		"-c",
		instructions,
		"--model",
		"resume",
		"fork",
		"native-id",
	]);
});

it("不把 -- 后的 prompt 内容解释为配置", () => {
	const args = ["resume", "native-id", "-c", 'model="first"', "--", "-c", "literal prompt"];
	normalizeCodexConfigOverridesBeforeSubcommand(args);
	expect(args).toEqual(["-c", 'model="first"', "resume", "native-id", "--", "-c", "literal prompt"]);
});
