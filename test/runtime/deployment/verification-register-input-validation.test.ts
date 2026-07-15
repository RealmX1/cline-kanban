import { describe, expect, it } from "vitest";

import {
	assertAuthoredVerificationDefinitionInputsRegisterable,
	assertVerificationScriptEntrypointStaysInsideAssetsDir,
} from "../../../src/commands/verification";
import type { RuntimeAuthoredVerificationDefinitionInput } from "../../../src/core/api-contract";

// register 入口的纯校验层（CI3）：entrypoint 静态护栏 + 整批先校验后持久化。
// 这里只测纯函数——registerVerification 在任何副作用（ensureVerificationAssetsDir /
// upsertAuthoredVerificationDefinition）之前整批调用 assertAuthoredVerificationDefinitionInputsRegisterable，
// 因此「任一定义非法 ⇒ 抛错 ⇒ 零持久化残留」由调用顺序保证。

function buildDefinitionInput(
	overrides: Partial<RuntimeAuthoredVerificationDefinitionInput>,
): RuntimeAuthoredVerificationDefinitionInput {
	return {
		kind: "automated_script",
		label: "示例验证",
		guidance: null,
		script: { entrypoint: "check.sh", interpreter: "bash", timeoutMs: 60000 },
		cleanup: { mode: "automatic", assetsDir: null, manualSteps: [] },
		...overrides,
	};
}

describe("assertVerificationScriptEntrypointStaysInsideAssetsDir", () => {
	it("放行资产目录内的相对 entrypoint", () => {
		for (const entrypoint of ["check.sh", "scripts/check.sh", "./check.sh", "a/../b.sh"]) {
			expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", entrypoint)).not.toThrow();
		}
	});

	it("拒绝绝对路径 entrypoint", () => {
		expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", "/tmp/escape.sh")).toThrow(
			/absolute path/,
		);
	});

	it("拒绝规范化后逃逸出资产目录的相对 entrypoint", () => {
		for (const entrypoint of ["../escape.sh", "a/../../escape.sh", ".."]) {
			expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", entrypoint)).toThrow(
				/stay inside the verification assets directory/,
			);
		}
	});

	it("拒绝空 / 指向资产目录自身的 entrypoint", () => {
		expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", "")).toThrow(/must not be empty/);
		expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", "   ")).toThrow(
			/must not be empty/,
		);
		expect(() => assertVerificationScriptEntrypointStaysInsideAssetsDir("示例验证", ".")).toThrow(
			/stay inside the verification assets directory/,
		);
	});
});

describe("assertAuthoredVerificationDefinitionInputsRegisterable", () => {
	it("automated_script 缺 script 时整批拒绝", () => {
		expect(() =>
			assertAuthoredVerificationDefinitionInputsRegisterable([buildDefinitionInput({ script: null })]),
		).toThrow(/must include a script entrypoint/);
	});

	it("数组后段定义非法时同样抛错（先整批校验、后持久化 ⇒ 不产生部分注册）", () => {
		const validFirst = buildDefinitionInput({ label: "合法定义" });
		const invalidSecond = buildDefinitionInput({
			label: "逃逸定义",
			script: { entrypoint: "../escape.sh", interpreter: "bash", timeoutMs: 60000 },
		});
		expect(() => assertAuthoredVerificationDefinitionInputsRegisterable([validFirst, invalidSecond])).toThrow(
			/stay inside the verification assets directory/,
		);
	});

	it("guided_manual 带非空 script 时同样过 entrypoint 护栏（运行触发只看 script 非空）", () => {
		const guidedManualWithEscapingScript = buildDefinitionInput({
			kind: "guided_manual",
			script: { entrypoint: "/etc/escape.sh", interpreter: "bash", timeoutMs: 60000 },
		});
		expect(() => assertAuthoredVerificationDefinitionInputsRegisterable([guidedManualWithEscapingScript])).toThrow(
			/absolute path/,
		);
	});

	it("guided_manual 无 script 与合法 automated_script 混批通过", () => {
		const guidedManualWithoutScript = buildDefinitionInput({ kind: "guided_manual", script: null });
		const validAutomatedScript = buildDefinitionInput({ label: "合法自动脚本" });
		expect(() =>
			assertAuthoredVerificationDefinitionInputsRegisterable([guidedManualWithoutScript, validAutomatedScript]),
		).not.toThrow();
	});
});
