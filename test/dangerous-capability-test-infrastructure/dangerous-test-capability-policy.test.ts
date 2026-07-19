import { describe, expect, it } from "vitest";

import { analyzeTestSourceDangerousCapabilityPolicy } from "./verify-test-dangerous-capability-policy";

const literalGitBinaryName = ["g", "it"].join("");
const productionGitEnvironmentFactoryName = ["createGit", "ProcessEnv"].join("");

function collectViolationCodes(filePath: string, sourceText: string): string[] {
	return analyzeTestSourceDangerousCapabilityPolicy({ filePath, sourceText }).map((violation) => violation.code);
}

describe("危险测试能力 AST 策略", () => {
	it("允许唯一 Git fixture 执行 literal Git binary", () => {
		expect(
			collectViolationCodes(
				"test/dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture.ts",
				`import { spawnSync } from "node:child_process"; spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"]);`,
			),
		).toEqual([]);
	});

	it("拒绝测试直接执行 Git binary", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				`import { spawnSync } from "node:child_process"; spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"]);`,
			),
		).toContain("direct-git-binary-execution");
	});

	it("拒绝 require、函数别名与常量 Git binary 组合绕过", () => {
		const violationCodes = collectViolationCodes(
			"test/runtime/unsafe.isolated-filesystem-mutation.test.ts",
			[
				'const { spawnSync: importedSpawnSync } = require("node:child_process");',
				"const aliasedSpawnSync = importedSpawnSync;",
				`const gitBinaryName = ${JSON.stringify(literalGitBinaryName)};`,
				'aliasedSpawnSync(gitBinaryName, ["status"]);',
			].join("\n"),
		);
		expect(violationCodes).toContain("direct-git-binary-execution");
		expect(violationCodes).toContain("child-process-used-outside-process-capability-lane");
	});

	it("拒绝子进程环境原样展开 process.env", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", [], { env: { ...process.env } });',
			),
		).toContain("raw-parent-environment-spread");
	});

	it("拒绝把 process.env 直接作为子进程环境", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", [], { env: process.env });',
			),
		).toContain("raw-parent-environment-spread");
	});

	it("拒绝通过条件展开隐藏完整父进程环境", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", [], { env: { ...(true ? {} : process.env) } });',
			),
		).toContain("raw-parent-environment-spread");
	});

	it("拒绝通过变量别名传递完整父进程环境", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				[
					'import { spawn } from "node:child_process";',
					"const inheritedEnvironmentVariables = process.env;",
					'spawn("node", [], { env: inheritedEnvironmentVariables });',
				].join("\n"),
			),
		).toContain("raw-parent-environment-spread");
	});

	it("拒绝用 Object.entries 复制完整父进程环境", () => {
		expect(
			collectViolationCodes(
				"test/integration/unsafe.integration.test.ts",
				[
					'import { spawn } from "node:child_process";',
					"const copiedEnvironmentVariables: Record<string, string | undefined> = {};",
					"for (const [name, value] of Object.entries(process.env)) copiedEnvironmentVariables[name] = value;",
					'spawn("node", [], { env: copiedEnvironmentVariables });',
				].join("\n"),
			),
		).toContain("raw-parent-environment-spread");
	});

	it("允许显式挑选单个父进程环境变量", () => {
		expect(
			collectViolationCodes(
				"test/integration/safe.integration.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", [], { env: { PATH: process.env.PATH } });',
			),
		).toEqual([]);
	});

	it("拒绝 production Git 环境执行真实 Git", () => {
		const violationCodes = collectViolationCodes(
			"test/integration/unsafe.integration.test.ts",
			[
				'import { spawnSync } from "node:child_process";',
				`import { ${productionGitEnvironmentFactoryName} } from "../../src/workspace/git-env";`,
				`spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"], { env: ${productionGitEnvironmentFactoryName}() });`,
			].join("\n"),
		);
		expect(violationCodes).toContain("production-git-environment-used-by-test");
	});

	it("拒绝普通 test lane 直接创建子进程", () => {
		expect(
			collectViolationCodes(
				"test/runtime/unsafe.test.ts",
				'import { spawn } from "node:child_process"; spawn("node", ["--version"]);',
			),
		).toContain("child-process-used-outside-process-capability-lane");
	});

	it("允许 process lane、integration lane 和不直接调用 child_process 的纯 mock", () => {
		const directProcessSource = 'import { spawn } from "node:child_process"; spawn("node", ["--version"]);';
		expect(
			collectViolationCodes("test/runtime/example.isolated-process-lifecycle.test.ts", directProcessSource),
		).toEqual([]);
		expect(collectViolationCodes("test/integration/example.integration.test.ts", directProcessSource)).toEqual([]);
		expect(
			collectViolationCodes(
				"test/runtime/example.test.ts",
				'vi.mock("node:child_process", () => ({ spawn: vi.fn() }));',
			),
		).toEqual([]);
	});

	it("部分 mock 不会豁免直接 Git 子进程调用", () => {
		const violationCodes = collectViolationCodes(
			"test/runtime/unsafe.test.ts",
			[
				'vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), spawnSync: vi.fn() }));',
				'import { spawnSync } from "node:child_process";',
				`spawnSync(${JSON.stringify(literalGitBinaryName)}, ["status"]);`,
			].join("\n"),
		);
		expect(violationCodes).toContain("direct-git-binary-execution");
		expect(violationCodes).toContain("child-process-used-outside-process-capability-lane");
	});
});
