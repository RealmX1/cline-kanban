import { describe, expect, it } from "vitest";
import { parseAdditionalAgentStartupArguments } from "../../../src/core/parse-additional-agent-startup-arguments";

describe("单次重启参数分词", () => {
	it.each([
		["", []],
		["  \t\n ", []],
		[
			'--cd "/路径 带空格" -c \'tui.resume_cwd="current"\'',
			["--cd", "/路径 带空格", "-c", 'tui.resume_cwd="current"'],
		],
		[String.raw`a\ b "c\"d" 'e\f' "" '' pre"mid dle"post`, ["a b", 'c"d', String.raw`e\f`, "", "", "premid dlepost"]],
		[String.raw`"C:\work\project" \$HOME '$(echo x)' ;`, [String.raw`C:\work\project`, "$HOME", "$(echo x)", ";"]],
	])("解析 %j 且不进行 shell 展开", (input, expected) => {
		expect(parseAdditionalAgentStartupArguments(input as string)).toEqual(expected);
	});
	it.each(["'未闭合", '"未闭合', "尾部\\", "a\0b"])("拒绝无效输入 %j", (input) => {
		expect(() => parseAdditionalAgentStartupArguments(input)).toThrow();
	});
});
