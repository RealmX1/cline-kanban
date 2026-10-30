import { describe, expect, it } from "vitest";
import {
	hasCodexStartupArgumentsRequiringNativeCliParsing,
	hasExplicitCodexConversationSelectionForRestart,
	hasExplicitCodexRemoteConnectionForRestart,
	mergeCodexAdditionalStartupArgumentsForRestart,
} from "../../../src/terminal/codex-additional-startup-arguments-for-restart";

describe("Codex 单次重启参数合并", () => {
	it.each([
		["--future-option", "resume", "--another-option", "fork"],
		["--future-option", "--last"],
		["--future-option", "--cd", "/other"],
		["--future-option", "--model", "other"],
		["--future-option", "--remote", "unix:///tmp/other.sock"],
		["-Z", "--dangerously-bypass-approvals-and-sandbox"],
	])("未知选项后的不透明后缀不改变绑定、默认参数或连接：%j", (...additionalArguments) => {
		const defaults = ["-C", "/task", "--model", "default-model", "-a", "on-request", "resume", "bound-id"];
		expect(hasExplicitCodexConversationSelectionForRestart(additionalArguments)).toBe(false);
		expect(hasExplicitCodexRemoteConnectionForRestart(additionalArguments)).toBe(false);
		expect(hasCodexStartupArgumentsRequiringNativeCliParsing(additionalArguments)).toBe(true);
		expect(mergeCodexAdditionalStartupArgumentsForRestart(defaults, additionalArguments)).toEqual([
			...defaults,
			...additionalArguments,
		]);
	});
	it("未知选项之前的已知覆盖仍然生效", () => {
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(
				["-C", "/task", "resume", "bound-id"],
				["--cd", "/chosen", "--future-option", "--last"],
			),
		).toEqual(["resume", "bound-id", "--cd", "/chosen", "--future-option", "--last"]);
	});
	it("长短别名、等号及紧连形式按最后一次补传替换，保留未知及可重复参数", () => {
		const defaults = ["-C", "/task", "--model", "old", "--add-dir", "/first", "resume", "bound-id"];
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(defaults, [
				"--cd=/new path",
				"-mfirst",
				"--model=last",
				"--add-dir",
				"/second",
				"--enable",
				"one",
				"--enable=two",
				"--future",
				"",
				"$(echo x)",
			]),
		).toEqual([
			"--add-dir",
			"/first",
			"resume",
			"bound-id",
			"--cd=/new path",
			"--model=last",
			"--add-dir",
			"/second",
			"--enable",
			"one",
			"--enable=two",
			"--future",
			"",
			"$(echo x)",
		]);
		expect(defaults).toEqual(["-C", "/task", "--model", "old", "--add-dir", "/first", "resume", "bound-id"]);
	});
	it("配置按键替换，模型和权限配置移除会压过它们的默认旗标", () => {
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(
				[
					"-m",
					"old",
					"--dangerously-bypass-approvals-and-sandbox",
					"-c",
					"model_reasoning_effort=low",
					"-c",
					"unrelated=true",
					"resume",
					"bound-id",
				],
				[
					"-cmodel=debug",
					"--config=model_reasoning_effort=medium",
					"-c",
					"model_reasoning_effort=high",
					"-csandbox_mode=read-only",
					"-capproval_policy=never",
				],
			),
		).toEqual([
			"-c",
			"unrelated=true",
			"resume",
			"bound-id",
			"-cmodel=debug",
			"-c",
			"model_reasoning_effort=high",
			"-csandbox_mode=read-only",
			"-capproval_policy=never",
		]);
	});
	it.each(["--full-auto", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "-anever"])(
		"点路径审批配置移除冲突的 %s，保留不同 granular 配置键",
		(defaultPermission) => {
			const additional = [
				"-c",
				"approval_policy.granular.sandbox_approval=true",
				"-c",
				"approval_policy.granular.rules=true",
			];
			expect(
				mergeCodexAdditionalStartupArgumentsForRestart([defaultPermission, "resume", "bound-id"], additional),
			).toEqual(["resume", "bound-id", ...additional]);
			expect(mergeCodexAdditionalStartupArgumentsForRestart(additional, [defaultPermission])).toEqual([
				defaultPermission,
			]);
		},
	);
	it("granular 审批表覆盖默认 bypass 和整体审批配置", () => {
		const granular = "approval_policy.granular={sandbox_approval=true,rules=true}";
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(
				["--dangerously-bypass-approvals-and-sandbox", "-c", 'approval_policy="never"', "resume", "bound-id"],
				["-c", granular],
			),
		).toEqual(["resume", "bound-id", "-c", granular]);
	});
	it.each(["--full-auto", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox"])(
		"补传 %s 清除默认权限",
		(flag) => {
			expect(
				mergeCodexAdditionalStartupArgumentsForRestart(
					["-auntrusted", "--sandbox=read-only", "-c", 'approval_policy="on-request"'],
					[flag],
				),
			).toEqual([flag]);
		},
	);
	it("显式会话选择替换默认 ID，带值选项中的 resume 不算会话选择", () => {
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(
				["-C", "/task", "resume", "bound-id"],
				["fork", "chosen-id", "--all"],
			),
		).toEqual(["-C", "/task", "fork", "chosen-id", "--all"]);
		expect(mergeCodexAdditionalStartupArgumentsForRestart(["resume", "bound-id"], ["--last"])).toEqual([
			"resume",
			"--last",
		]);
		expect(mergeCodexAdditionalStartupArgumentsForRestart(["resume", "bound-id"], ["--model", "resume"])).toEqual([
			"resume",
			"bound-id",
			"--model",
			"resume",
		]);
	});
	it.each([["resume"], ["fork"], ["resume", "--help"], ["fork", "--model", "chosen"]])(
		"没有目标的原生选择器必须由 CLI 解析：%j",
		(...additional) => {
			const merged = mergeCodexAdditionalStartupArgumentsForRestart(["resume", "bound-id"], additional);
			expect(hasCodexStartupArgumentsRequiringNativeCliParsing(merged)).toBe(true);
		},
	);
	it.each([
		["resume", "chosen-id"],
		["fork", "--last"],
		["resume", "--model", "resume", "chosen-id"],
	])("带目标的恢复仍可交给受管宿主：%j", (...arguments_) => {
		expect(hasCodexStartupArgumentsRequiringNativeCliParsing(arguments_)).toBe(false);
	});
	it.each([
		["-i", "/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
		["--image=/tmp/a.png", "/tmp/b.png"],
		["--image", "/tmp/a.png", "resume", "fork"],
	])("多值图片参数不冒充会话选择，交给原生 CLI：%j", (...additional) => {
		expect(hasExplicitCodexConversationSelectionForRestart(additional)).toBe(false);
		expect(hasCodexStartupArgumentsRequiringNativeCliParsing(additional)).toBe(true);
		expect(mergeCodexAdditionalStartupArgumentsForRestart(["resume", "bound-id"], additional)).toEqual([
			"resume",
			"bound-id",
			...additional,
		]);
	});
	it("紧连图片值不吞掉后续显式会话选择", () => {
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(
				["resume", "bound-id"],
				["--image=/tmp/a.png", "fork", "chosen-id"],
			),
		).toEqual(["--image=/tmp/a.png", "fork", "chosen-id"]);
	});
	it.each([
		["--model", "--cd", "/path"],
		["--sandbox", "--ask-for-approval", "never"],
		["-C", "--"],
		["--enable", "-h"],
	])("后续选项不能充当已知选项的值：%j", (...additional) => {
		expect(() => mergeCodexAdditionalStartupArgumentsForRestart([], additional)).toThrow("缺少参数值");
	});
	it("空值和显式紧连的连字符值逐字保留", () => {
		expect(mergeCodexAdditionalStartupArgumentsForRestart([], ["--model", ""])).toEqual(["--model", ""]);
		expect(mergeCodexAdditionalStartupArgumentsForRestart([], ["--model=-literal"])).toEqual(["--model=-literal"]);
	});
	it("终止符后的参数逐字保留，已知选项缺值在重启前可报错", () => {
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart([], ["constructor", "toString", "-c", "constructor=debug"]),
		).toEqual(["constructor", "toString", "-c", "constructor=debug"]);
		expect(
			mergeCodexAdditionalStartupArgumentsForRestart(["--no-alt-screen", "-h"], ["--no-alt-screen", "--help"]),
		).toEqual(["--no-alt-screen", "--help"]);
		expect(mergeCodexAdditionalStartupArgumentsForRestart(["--model=old"], ["--", "--model=new", ""])).toEqual([
			"--model=old",
			"--",
			"--model=new",
			"",
		]);
		expect(() => mergeCodexAdditionalStartupArgumentsForRestart([], ["--cd"])).toThrow();
		expect(() => mergeCodexAdditionalStartupArgumentsForRestart([], ["--cd", "\0"])).toThrow();
	});
});
