import { describe, expect, it } from "vitest";

import { analyzeTestSourceGitRepositoryMutationSafetyPolicy } from "./verify-test-git-repository-mutation-safety-policy";

const literalGitBinaryName = ["g", "it"].join("");
const productionGitEnvironmentFactoryName = ["createGit", "ProcessEnv"].join("");

function collectViolationCodes(filePath: string, sourceText: string): string[] {
	return analyzeTestSourceGitRepositoryMutationSafetyPolicy({ filePath, sourceText }).map(
		(violation) => violation.code,
	);
}

describe("Git 测试安全 AST 策略", () => {
	it("允许唯一 Git fixture 与 repository canary 执行 literal Git binary", () => {
		const sourceText = `import { spawnSync } from "node:child_process"; spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"]);`;
		expect(
			collectViolationCodes(
				"test/git-repository-mutation-safety/isolated-git-test-workspace-fixture.ts",
				sourceText,
			),
		).toEqual([]);
		expect(
			collectViolationCodes(
				"test/git-repository-mutation-safety/run-test-projects-with-invoking-repository-mutation-canary.ts",
				sourceText,
			),
		).toEqual([]);
	});

	it.each([
		'import { spawnSync } from "node:child_process"; spawnSync("git", ["status"]);',
		'import * as childProcess from "node:child_process"; childProcess.spawnSync("git", ["status"]);',
	])("拒绝测试直接执行 literal Git binary", (sourceText) => {
		expect(collectViolationCodes("test/runtime/unsafe.test.ts", sourceText)).toContain("direct-git-binary-execution");
	});

	it.each([
		'import { spawn } from "node:child_process"; spawn("node", [], { env: process.env });',
		'import { spawn } from "node:child_process"; spawn("node", [], { env: { ...process.env } });',
	])("拒绝把完整父进程环境直接交给子进程", (sourceText) => {
		expect(collectViolationCodes("test/integration/unsafe.integration.test.ts", sourceText)).toContain(
			"raw-parent-environment-spread",
		);
	});

	it("允许显式挑选单个父进程环境变量", () => {
		expect(
			collectViolationCodes(
				"test/runtime/safe.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", [], { env: { PATH: process.env.PATH } });',
			),
		).toEqual([]);
	});

	it("拒绝 production Git 环境执行真实 Git", () => {
		const violationCodes = collectViolationCodes(
			"test/runtime/unsafe.test.ts",
			[
				'import { spawnSync } from "node:child_process";',
				`import { ${productionGitEnvironmentFactoryName} } from "../../src/core/git-process-env";`,
				`spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"], { env: ${productionGitEnvironmentFactoryName}() });`,
			].join("\n"),
		);
		expect(violationCodes).toContain("production-git-environment-used-by-test");
	});

	it("不因未参与 Git 调用的 production helper 文本误报", () => {
		const violationCodes = collectViolationCodes(
			"test/runtime/unsafe.test.ts",
			[
				'import { spawnSync } from "node:child_process";',
				`import { ${productionGitEnvironmentFactoryName} } from "../../src/core/git-process-env";`,
				`spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"], { env: { PATH: process.env.PATH } });`,
			].join("\n"),
		);
		expect(violationCodes).toEqual(["direct-git-binary-execution"]);
	});

	it("允许普通测试直接启动非 Git 子进程", () => {
		expect(
			collectViolationCodes(
				"test/runtime/process-behavior.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", ["--version"]);',
			),
		).toEqual([]);
	});
});
