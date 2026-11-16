import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const preparationScript = resolve(
	".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
);
const nodeBinarySha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");

function digest(contents: string | Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

function pythonJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${pythonJson(key)}: ${pythonJson((value as Record<string, unknown>)[key])}`)
			.join(", ")}}`;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Python 兼容 JSON 不支持 undefined");
	return serialized.replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

type ReuseReport = {
	status: string;
	availableSourceValidationChecks: Array<{ status: string; sourceFormat: string }>;
	sourceValidationCheckResults: Array<{ decision: string }>;
	evidenceDiscoveryIssues: Array<{ reason: string }>;
	evidenceVerificationStatistics: { hashedFiles: number; evidenceBytesHashed: number };
	consumedEvidenceSnapshots: Array<{ snapshotPath: string; sha256: string }>;
	inputFingerprintSha256: string;
};

function createValidationFixture() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	onTestFinished(() => fixture.cleanup());
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "candidate-source" });
	const sourceCheckoutPath = repository.repositoryPath;
	writeFileSync(join(sourceCheckoutPath, "candidate-source.txt"), "已固定候选\n");
	const commit = repository.commitAllRepositoryFilesAtDate({
		message: "固定隔离候选",
		authorAndCommitterIsoDate: "2026-11-04T00:00:00Z",
	});
	const tree = repository.runGit(["rev-parse", "HEAD^{tree}"]).stdout.trim();
	const gitCommonDirectory = resolve(
		sourceCheckoutPath,
		repository.runGit(["rev-parse", "--git-common-dir"]).stdout.trim(),
	);
	const runtimeHomeDirectoryPath = join(fixture.fixtureRootDirectoryPath, "isolated-runtime-home");
	const output = join(fixture.fixtureRootDirectoryPath, "deployment-source-validation");
	const planPath = join(fixture.fixtureRootDirectoryPath, "frozen-validation-plan.json");
	const executedSourceValidationCounterPath = join(fixture.fixtureRootDirectoryPath, "executed-check-counter.txt");
	const command = {
		name: "仅缺失时执行的源码检查",
		argv: [
			process.execPath,
			"-e",
			"require('node:fs').appendFileSync(process.argv[1], '检查\\n')",
			executedSourceValidationCounterPath,
		],
		coverage: ["候选源码检查"],
	};
	writeJson(planPath, { schemaVersion: 1, commands: [command] });
	function childProcessEnvironment() {
		return fixture.createIsolatedChildProcessEnvironment({
			RVF_USER_LOCAL_DATA_ROOT: join(fixture.isolatedHomeDirectoryPath, ".rvf/user-local-data"),
		});
	}
	function pythonRuntimeIdentity(environment: NodeJS.ProcessEnv) {
		const result = spawnSync(
			"python3",
			[
				"-c",
				"import json,pathlib,platform,sys;print(json.dumps({'pythonExecutable':str(pathlib.Path(sys.executable).resolve()),'pythonVersion':sys.version,'platform':platform.platform()}))",
			],
			{ env: environment, encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		return JSON.parse(result.stdout) as { pythonExecutable: string; pythonVersion: string; platform: string };
	}
	function currentEnvironmentIdentity() {
		const environment = Object.fromEntries(
			Object.entries(childProcessEnvironment()).filter(
				([key]) =>
					!key.startsWith("GIT_") &&
					!key.startsWith("BASE_BRANCH_SYNC_") &&
					!key.startsWith("RVF_INDEPENDENT_") &&
					!["_", "SHLVL", "PWD", "OLDPWD", "__PYVENV_LAUNCHER__"].includes(key),
			),
		);
		environment.PATH = `${dirname(process.execPath)}:${environment.PATH || ""}`;
		return {
			nodeExecutable: realpathSync(process.execPath),
			nodeVersion: process.versions.node,
			nodeModulesAbi: process.versions.modules,
			platform: process.platform,
			architecture: process.arch,
			lockfiles: {},
			installedDependencyMetadata: {},
			environment,
		};
	}
	function run(
		options: {
			inspectOnly?: boolean;
			observeRecovery?: boolean;
			plan?: boolean;
			commit?: string;
			environment?: Record<string, string>;
		} = {},
	) {
		const arguments_ = [
			preparationScript,
			"--source-checkout-path",
			sourceCheckoutPath,
			"--candidate-source-commit",
			options.commit ?? commit,
			"--runtime-home-directory",
			runtimeHomeDirectoryPath,
			"--output-directory",
			output,
			...(options.plan === false ? [] : ["--validation-plan", planPath]),
			...(options.inspectOnly ? ["--inspect-only"] : []),
			...(options.observeRecovery ? ["--observe-recovery-evidence"] : []),
		];
		const result = spawnSync(process.execPath, arguments_, {
			env: { ...childProcessEnvironment(), ...options.environment },
			encoding: "utf8",
			timeout: 15_000,
		});
		return {
			...result,
			summary: JSON.parse(result.stdout) as {
				ok: boolean;
				status: string;
				reason?: string;
				evidenceSha256?: string;
				reusedSourceValidationCheckCount: number;
			},
			report: () =>
				JSON.parse(
					readFileSync(join(output, "source-validation-evidence-reuse-report.json"), "utf8"),
				) as ReuseReport,
		};
	}
	function addStandardRecord(
		options: {
			failed?: boolean;
			interruptedExitCode?: 130 | -2;
			nodeVersion?: string;
			wrongRepository?: boolean;
			wrongContentManifest?: boolean;
			wrongEnvironment?: boolean;
			missingEnvironment?: boolean;
			operationName?: string;
			startedAt?: string;
			concludedAt?: string;
		} = {},
	) {
		const operationDirectory = join(
			gitCommonDirectory,
			"base-branch-sync/durable-operations",
			options.operationName ?? "isolated-handback",
		);
		const recordDirectory = join(
			operationDirectory,
			"commands",
			options.interruptedExitCode !== undefined
				? "interrupted-check"
				: options.failed
					? "failed-check"
					: "passed-check",
		);
		mkdirSync(recordDirectory, { recursive: true });
		const stdoutPath = join(recordDirectory, "stdout");
		const stderrPath = join(recordDirectory, "stderr");
		writeFileSync(stdoutPath, "隔离检查原件\n");
		writeFileSync(stderrPath, "");
		const recordPath = join(recordDirectory, "current-tree-validation.json");
		const commandFingerprint = digest(
			`{"argv": [${command.argv.map((argument) => JSON.stringify(argument).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)).join(", ")}], "executable": ${JSON.stringify(process.execPath)}, "executableSha256": "${nodeBinarySha256}", "scriptSha256": {}}`,
		);
		const identity = {
			taskId: "isolated-producer-task",
			sessionId: "isolated-native-session",
			gitCommonDirectory: options.wrongRepository
				? join(gitCommonDirectory, "unrelated-repository")
				: gitCommonDirectory,
			worktree: sourceCheckoutPath,
		};
		const pathBytes = Buffer.from("candidate-source.txt");
		const contentBytes = readFileSync(join(sourceCheckoutPath, "candidate-source.txt"));
		const pathLength = Buffer.alloc(8);
		pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
		const contentLength = Buffer.alloc(8);
		contentLength.writeBigUInt64BE(BigInt(contentBytes.length));
		const contentManifest = createHash("sha256")
			.update("P")
			.update(pathLength)
			.update(pathBytes)
			.update("F-")
			.update(contentLength)
			.update(contentBytes)
			.digest("hex");
		const currentEnvironment = currentEnvironmentIdentity();
		const currentPython = pythonRuntimeIdentity(currentEnvironment.environment);
		const validationEnvironment = {
			pythonExecutable: currentPython.pythonExecutable,
			pythonVersion: currentPython.pythonVersion,
			environment: options.wrongEnvironment
				? { ...currentEnvironment.environment, SOURCE_CHECK_MODE: "historical-pass" }
				: currentEnvironment.environment,
		};
		const preflight = {
			status: "READY",
			runtime: {
				executable: process.execPath,
				version: options.nodeVersion ?? process.versions.node,
				modulesAbi: process.versions.modules,
			},
			runtimeRequirement: [">=22"],
			dependencies: { status: "NOT_DECLARED" },
			nativeModules: [],
		};
		const preflightFingerprint = digest(
			pythonJson({
				runtime: preflight.runtime,
				requirement: preflight.runtimeRequirement[0],
				dependencies: preflight.dependencies,
				nativeModules: preflight.nativeModules,
			}),
		);
		writeJson(recordPath, {
			schemaVersion: 1,
			kind: "base-branch-sync-current-tree-validation",
			...identity,
			treeOid: tree,
			contentManifestSha256: options.wrongContentManifest ? "a".repeat(64) : contentManifest,
			environmentFingerprintSha256: options.missingEnvironment
				? null
				: digest(
						pythonJson({
							node: preflightFingerprint,
							pythonExecutable: validationEnvironment.pythonExecutable,
							pythonVersion: validationEnvironment.pythonVersion,
							environment: validationEnvironment.environment,
						}),
					),
			commandEnvironmentFingerprintSha256: commandFingerprint,
			context: "task-tree",
			argv: command.argv,
			coverage: command.coverage,
			status: options.interruptedExitCode !== undefined ? "rejected" : options.failed ? "failed" : "passed",
			exitCode: options.interruptedExitCode ?? (options.failed ? 1 : 0),
			startedAtUtc: options.startedAt,
			finishedAtUtc: options.concludedAt,
			stdoutPath,
			stdoutSha256: digest(readFileSync(stdoutPath)),
			stderrPath,
			stderrSha256: digest(""),
		});
		writeJson(join(recordDirectory, "command.json"), {
			argv: command.argv,
			startedAtUtc: options.startedAt,
			finishedAtUtc: options.concludedAt,
		});
		const statePath = join(operationDirectory, "operation-state.json");
		const previous = existsSync(statePath)
			? (JSON.parse(readFileSync(statePath, "utf8")) as { validationRecords: unknown[] }).validationRecords
			: [];
		writeJson(statePath, {
			...identity,
			environmentPreflight: { ...preflight, environmentFingerprintSha256: preflightFingerprint },
			validationRecords: [...previous, { path: recordPath, sha256: digest(readFileSync(recordPath)) }],
		});
		return { recordPath, stdoutPath };
	}
	function addLegacyBundle(
		options: {
			wrongContentManifest?: boolean;
			interruptedExitCode?: 130 | -2;
			interruptedPrecommitExitCode?: 130 | -2;
		} = {},
	) {
		const bundleDirectory = join(
			runtimeHomeDirectoryPath,
			"cross-task-handoff-artifacts/isolated-workspace/isolated-task/handback",
		);
		const originals = join(runtimeHomeDirectoryPath, "verifications/isolated-verification");
		mkdirSync(originals, { recursive: true });
		const runnerPath = join(originals, "frozen-verification-runner.py");
		const runner = `node_directory = pathlib.Path('${dirname(process.execPath)}')\nif mode == 'typecheck':\n    execute(npm+['run','typecheck'])\n    execute(npm+['run','web:typecheck'])\nelse:\n    raise ValueError('不支持的阶段')\n`;
		writeFileSync(runnerPath, runner);
		const stdoutPath = join(originals, "typecheck.stdout");
		const stderrPath = join(originals, "typecheck.stderr");
		writeFileSync(stdoutPath, "双端类型检查通过\n");
		writeFileSync(stderrPath, "");
		const recordPath = join(originals, "final-typecheck.json");
		const candidatePath = join(sourceCheckoutPath, "candidate-source.txt");
		const legacyContentManifest = digest(
			pythonJson([["candidate-source.txt", digest(readFileSync(candidatePath)), statSync(candidatePath).mode]]),
		);
		const snapshot = {
			tree,
			contentManifestSha256: options.wrongContentManifest ? "c".repeat(64) : legacyContentManifest,
		};
		writeJson(recordPath, {
			phase: "typecheck",
			argv: ["/isolated/python", runnerPath, "typecheck"],
			cwd: sourceCheckoutPath,
			runnerSha256: digest(runner),
			before: snapshot,
			after: snapshot,
			validationEnvironment: currentEnvironmentIdentity(),
			status: options.interruptedExitCode === undefined ? "passed" : "interrupted",
			exitCode: options.interruptedExitCode ?? 0,
			stdoutPath,
			stdoutSha256: digest(readFileSync(stdoutPath)),
			stderrPath,
			stderrSha256: digest(""),
		});
		const precommitLogPath = join(originals, "precommit.stdout");
		if (options.interruptedPrecommitExitCode !== undefined)
			writeFileSync(precommitLogPath, "vitest run --project precommit-safe\nSIGINT\n");
		writeJson(join(bundleDirectory, "final-complete-tree-verification-evidence.json"), {
			taskId: "isolated-task",
			taskCommit: commit,
			completeTree: tree,
			status: "passed",
			...(options.interruptedPrecommitExitCode !== undefined
				? {
						precommit: {
							taskId: "isolated-task",
							commit,
							completeTree: tree,
							status: "interrupted",
							exitCode: options.interruptedPrecommitExitCode,
							rawLog: precommitLogPath,
							rawLogSha256: digest(readFileSync(precommitLogPath)),
						},
					}
				: {}),
			proofs: {
				typecheck: {
					recordPath,
					recordSha256: digest(readFileSync(recordPath)),
					tree,
					contentManifestSha256: snapshot.contentManifestSha256,
				},
			},
		});
		writeJson(join(bundleDirectory, "commit-and-base-branch-sync-result.json"), {
			status: "LOCAL_COMMIT_AND_BASE_HANDBACK_COMPLETE",
			taskId: "isolated-task",
			taskHead: commit,
			completeTree: tree,
			baseWorktree: sourceCheckoutPath,
		});
		const files = [runnerPath, stdoutPath, stderrPath, recordPath].map((sourcePath) => {
			const durableCopyPath = join(
				bundleDirectory,
				"validation-and-recovery-audit",
				sourcePath.split("/").at(-1) ?? "",
			);
			mkdirSync(dirname(durableCopyPath), { recursive: true });
			copyFileSync(sourcePath, durableCopyPath);
			return { sourcePath, durableCopyPath, sha256: digest(readFileSync(sourcePath)) };
		});
		writeJson(join(bundleDirectory, "validation-audit-copy-manifest.json"), { fileCount: files.length, files });
		writeJson(planPath, {
			schemaVersion: 1,
			commands: [
				{ name: "运行时类型检查", argv: ["npm", "run", "typecheck"] },
				{ name: "Web 类型检查", argv: ["npm", "run", "web:typecheck"] },
			],
		});
		return { originals, bundleDirectory };
	}
	return {
		fixture,
		repository,
		sourceCheckoutPath,
		commit,
		tree,
		gitCommonDirectory,
		runtimeHomeDirectoryPath,
		output,
		planPath,
		executedSourceValidationCounterPath,
		command,
		run,
		currentEnvironmentIdentity,
		childProcessEnvironment,
		pythonRuntimeIdentity,
		addStandardRecord,
		addLegacyBundle,
	};
}

describe("local deploy 自动复用源码验证证据", () => {
	it("标准记录同候选、命令与环境时自动复用，日志不会输出给 Agent，也不会启动测试", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		const result = fixture.run();
		expect(result.status).toBe(0);
		expect(result.summary.reusedSourceValidationCheckCount).toBe(1);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
		expect(result.stdout.length).toBeLessThan(4096);
		expect(result.report().consumedEvidenceSnapshots).toHaveLength(3);
		expect(result.report().evidenceVerificationStatistics.hashedFiles).toBe(7);
	});

	it("备用路径自动静态还原双端命令，原件清理后仍消费同摘要持久副本", () => {
		const fixture = createValidationFixture();
		const bundle = fixture.addLegacyBundle();
		rmSync(bundle.originals, { recursive: true });
		const result = fixture.run();
		expect(result.status).toBe(0);
		expect(result.summary.reusedSourceValidationCheckCount).toBe(2);
		expect(result.report().evidenceDiscoveryIssues).toEqual([]);
	});

	it("只执行缺失项，独立调用接续复用完成结果，不重复执行", () => {
		const fixture = createValidationFixture();
		expect(fixture.run().status).toBe(0);
		expect(fixture.run().report().sourceValidationCheckResults[0].decision).toBe("reused_previous_execution");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
	});

	it("环境只持久化摘要，私密哨兵参与缓存身份但不进入报告或接续状态", () => {
		const fixture = createValidationFixture();
		const firstSecret = "harmless-private-sentinel-first-8f0c47";
		const secondSecret = "harmless-private-sentinel-second-51d92a";
		expect(fixture.run({ environment: { SOURCE_VALIDATION_PRIVATE_SENTINEL: firstSecret } }).status).toBe(0);
		expect(fixture.run({ environment: { SOURCE_VALIDATION_PRIVATE_SENTINEL: secondSecret } }).status).toBe(0);
		const persisted = ["source-validation-evidence-reuse-report.json", "source-validation-execution-state.json"]
			.map((name) => readFileSync(join(fixture.output, name), "utf8"))
			.join("\n");
		expect(persisted).not.toContain(firstSecret);
		expect(persisted).not.toContain(secondSecret);
		expect(persisted).toContain("processEnvironmentSha256");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n检查\n");
	});

	it("部分命中时仅补跑不同 argv，覆盖名称相同不造成误跳过", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		const second = {
			...fixture.command,
			name: "另一项检查",
			argv: [
				process.execPath,
				"-e",
				"require('node:fs').appendFileSync(process.argv[1], '仅补此项\\n')",
				fixture.executedSourceValidationCounterPath,
			],
		};
		writeJson(fixture.planPath, { schemaVersion: 1, commands: [fixture.command, second] });
		const result = fixture.run();
		expect(result.status).toBe(0);
		expect(result.report().sourceValidationCheckResults.map((check) => check.decision)).toEqual([
			"reused_source_evidence",
			"executed_missing_check",
		]);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("仅补此项\n");
	});

	it("同树真实失败不会在下次调用时被更早通过或自动重跑掩盖", () => {
		const fixture = createValidationFixture();
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "红测", argv: [process.execPath, "-e", "process.exit(1)"] }],
		});
		expect(fixture.run().status).toBe(1);
		expect(fixture.run().status).toBe(1);
		expect(
			JSON.parse(readFileSync(join(fixture.output, "source-validation-execution-state.json"), "utf8")).attempts,
		).toHaveLength(1);
	});

	it("当前检查自行退出 130 时保留中止，并只允许有界接续补验", () => {
		const fixture = createValidationFixture();
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "自行中止的检查", argv: [process.execPath, "-e", "process.exit(130)"] }],
		});
		for (let invocation = 0; invocation < 3; invocation++) {
			const result = fixture.run();
			expect(result.summary.status).toBe("machine_evidence_pending");
			expect(result.report().sourceValidationCheckResults[0].decision).toBe("machine_evidence_pending");
		}
		const state = JSON.parse(readFileSync(join(fixture.output, "source-validation-execution-state.json"), "utf8"));
		expect(state.attempts).toHaveLength(2);
		expect(state.attempts.map((attempt: { status: string }) => attempt.status)).toEqual([
			"interrupted",
			"interrupted",
		]);
	});

	it.each([130, -2] as const)("接回持久监督结果 %s 时保留中止，不能缓存为质量失败", (exitCode) => {
		const fixture = createValidationFixture();
		expect(fixture.run().status).toBe(0);
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		const attempt = state.attempts[0];
		attempt.status = "running";
		writeJson(statePath, state);
		const supervision = JSON.parse(readFileSync(attempt.nativeSupervisionPath, "utf8"));
		writeJson(attempt.nativeSupervisionPath, { ...supervision, status: "completed", exitCode, interrupted: false });
		expect(fixture.run().status).toBe(0);
		const recoveredState = JSON.parse(readFileSync(statePath, "utf8"));
		expect(recoveredState.attempts.map((entry: { status: string }) => entry.status)).toEqual([
			"interrupted",
			"passed",
		]);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n检查\n");
	});

	it.each([130, -2] as const)("备用包的退出码 %s 保留为中止，不阻塞当前候选补验", (interruptedExitCode) => {
		const fixture = createValidationFixture();
		fixture.addLegacyBundle({ interruptedExitCode });
		const result = fixture.run({ inspectOnly: true });
		expect(result.report().availableSourceValidationChecks[0].status).toBe("interrupted");
		expect(result.report().sourceValidationCheckResults.map((check) => check.decision)).toEqual([
			"missing_check",
			"missing_check",
		]);
	});

	it.each([130, -2] as const)("备用包的 precommit 退出码 %s 也不能作为质量失败", (interruptedPrecommitExitCode) => {
		const fixture = createValidationFixture();
		fixture.addLegacyBundle({ interruptedPrecommitExitCode });
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "提交前检查", argv: ["npm", "run", "test:precommit"] }],
		});
		const result = fixture.run({ inspectOnly: true });
		expect(result.report().availableSourceValidationChecks.at(-1)?.status).toBe("interrupted");
		expect(result.report().sourceValidationCheckResults[0].decision).toBe("missing_check");
	});

	it("验证计划增加检查时保留已完成项，不因整份计划变化重跑它", () => {
		const fixture = createValidationFixture();
		expect(fixture.run().status).toBe(0);
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [
				fixture.command,
				{
					name: "新增检查",
					argv: [
						process.execPath,
						"-e",
						"require('node:fs').appendFileSync(process.argv[1], '新增\\n')",
						fixture.executedSourceValidationCounterPath,
					],
				},
			],
		});
		expect(
			fixture
				.run()
				.report()
				.sourceValidationCheckResults.map((check) => check.decision),
		).toEqual(["reused_previous_execution", "executed_missing_check"]);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n新增\n");
	});

	it("检查中改变源码即使退出零也不能缓存通过，恢复源码后必须补验", () => {
		const fixture = createValidationFixture();
		const candidateFile = join(fixture.sourceCheckoutPath, "candidate-source.txt");
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [
				{
					name: "源码稳定性检查",
					argv: [
						process.execPath,
						"-e",
						"const fs=require('node:fs');if(!fs.existsSync(process.argv[2])){fs.writeFileSync(process.argv[1],'检查中的未提交改动');fs.writeFileSync(process.argv[2],'首次\\n')}else{fs.appendFileSync(process.argv[2],'重验\\n')}",
						candidateFile,
						fixture.executedSourceValidationCounterPath,
					],
				},
			],
		});
		expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		writeFileSync(candidateFile, "已固定候选\n");
		expect(fixture.run().status).toBe(0);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("首次\n重验\n");
	});

	it("原子进程仍活着时只等待机器证据，不启动第二份检查", () => {
		const fixture = createValidationFixture();
		fixture.run();
		const path = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(path, "utf8"));
		state.attempts[0].status = "running";
		state.attempts[0].childProcessId = process.pid;
		state.attempts[0].childProcessStartIdentity = null;
		rmSync(state.attempts[0].nativeSupervisionPath);
		writeJson(path, state);
		expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
	});

	it("旧执行者确认退出后自动接回持久目录，残留准备文件不阻塞接续", () => {
		const fixture = createValidationFixture();
		mkdirSync(fixture.output, { recursive: true });
		writeJson(join(fixture.output, "source-validation-preparation-owner.json"), {
			processId: 999999999,
			processStartIdentity: "已退出的旧执行者",
			ownershipToken: "old-owner",
		});
		writeFileSync(
			join(fixture.output, "source-validation-preparation-owner.json.orphan.prepared"),
			"未发布的准备中记录",
		);
		expect(fixture.run().status).toBe(0);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
	});

	it("原生命令未启动可有界补试，不冒充质量失败或无限重试", () => {
		const fixture = createValidationFixture();
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [
				{
					name: "待恢复的测试解释器",
					argv: [join(fixture.fixture.fixtureRootDirectoryPath, "missing-test-executable")],
				},
			],
		});
		for (let invocation = 0; invocation < 3; invocation++)
			expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		expect(
			JSON.parse(readFileSync(join(fixture.output, "source-validation-execution-state.json"), "utf8")).attempts,
		).toHaveLength(2);
	});

	it("已接受的标准记录随生产任务清理后，接续仍自动核对自己的持久证据副本", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		expect(fixture.run().summary.reusedSourceValidationCheckCount).toBe(1);
		rmSync(join(fixture.gitCommonDirectory, "base-branch-sync"), { recursive: true });
		expect(fixture.run().summary.reusedSourceValidationCheckCount).toBe(1);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("本次持久副本损坏时从仍可信的原件自动恢复，继续复用而非重跑测试", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		const result = fixture.run();
		const snapshot = result.report().consumedEvidenceSnapshots[0];
		writeFileSync(snapshot.snapshotPath, "损坏的本次副本");
		expect(fixture.run().summary.reusedSourceValidationCheckCount).toBe(1);
		expect(digest(readFileSync(snapshot.snapshotPath))).toBe(snapshot.sha256);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("输出目录软链回候选时在任何写入之前拒绝，候选仍逐字不变", () => {
		const fixture = createValidationFixture();
		symlinkSync(fixture.sourceCheckoutPath, fixture.output, "dir");
		expect(fixture.run().summary.reason).toContain("源码目录之外");
		expect(fixture.repository.runGit(["status", "--porcelain=v1"]).stdout).toBe("");
	});

	it("base-branch-sync 没有新测试记录时，直接采用同树 RVF 原生验证命令", () => {
		const fixture = createValidationFixture();
		const runDirectory = join(
			fixture.fixture.isolatedHomeDirectoryPath,
			".rvf/user-local-data/task-snapshot-reviews/isolated-rvf-run",
		);
		const attemptDirectory = join(runDirectory, "final-validation/attempt-001");
		const commandDirectory = join(attemptDirectory, "command-001");
		const executionPlanPath = join(runDirectory, "execution-plan.json");
		const nativeEnvironment = fixture.childProcessEnvironment();
		const nativePython = fixture.pythonRuntimeIdentity(nativeEnvironment);
		writeJson(executionPlanPath, {
			validation_commands: [fixture.command.argv],
			machine_context: { task_id: "rvf-producer-task", native_node: process.execPath },
		});
		writeJson(join(runDirectory, "run.json"), {
			schema_version: 1,
			run_id: "isolated-rvf-run",
			git_common_directory: fixture.gitCommonDirectory,
			validated_candidate_commit: fixture.commit,
			execution_plan_sha256: digest(readFileSync(executionPlanPath)),
		});
		writeJson(join(runDirectory, "validation.json"), {
			status: "passed",
			returncode: 0,
			candidate_commit: fixture.commit,
			tested_tree: fixture.tree,
			commands: [fixture.command.argv],
			completed_commands: 1,
			attempt_directory: attemptDirectory,
			runtime_environment: {
				platform: nativePython.platform,
				python: nativePython.pythonVersion,
				python_executable: nativePython.pythonExecutable,
				environment_sha256: digest(pythonJson(nativeEnvironment)),
			},
		});
		writeJson(join(commandDirectory, "execution.json"), {
			argv: fixture.command.argv,
			cwd: fixture.sourceCheckoutPath,
			source_tree_before: fixture.tree,
			source_tree_after: fixture.tree,
			status: "passed",
			returncode: 0,
		});
		writeFileSync(join(commandDirectory, "stdout.txt"), "RVF 原始验证通过\n");
		writeFileSync(join(commandDirectory, "stderr.txt"), "");
		writeJson(join(commandDirectory, "command-supervision.json"), {
			argv: fixture.command.argv,
			status: "completed",
			owned_process_exit_status: "exited",
			command_execution_started: true,
			returncode: 0,
			stdout_sha256: digest(readFileSync(join(commandDirectory, "stdout.txt"))),
			stderr_sha256: digest(""),
		});
		const result = fixture.run();
		expect(result.status).toBe(0);
		expect(result.summary.reusedSourceValidationCheckCount).toBe(1);
		expect(result.report().availableSourceValidationChecks[0].sourceFormat).toBe(
			"rvf-task-snapshot-original-validation",
		);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
		writeFileSync(join(commandDirectory, "stdout.txt"), "原生记录被改写");
		expect(fixture.run({ inspectOnly: true }).report().sourceValidationCheckResults[0].decision).toBe(
			"missing_check",
		);
	});

	it("只读发现不执行历史 argv，没有验证计划也不会默认启动全量测试", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		expect(fixture.run({ inspectOnly: true, plan: false }).summary.status).toBe("inspection_complete");
		expect(fixture.run({ plan: false }).status).toBe(2);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("恢复观察只返回语义指纹，重复采样与报告统计变化不写盘或唤醒", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		fixture.run();
		const reportPath = join(fixture.output, "source-validation-evidence-reuse-report.json");
		const reportBefore = readFileSync(reportPath, "utf8");
		const first = fixture.run({ observeRecovery: true });
		expect(first.summary.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fixture.run({ observeRecovery: true }).summary).toEqual(first.summary);
		expect(readFileSync(reportPath, "utf8")).toBe(reportBefore);
		const report = JSON.parse(reportBefore);
		report.evidenceVerificationStatistics.metadataFilesRead += 100;
		writeJson(reportPath, report);
		expect(fixture.run({ observeRecovery: true }).summary).toEqual(first.summary);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it.each([
		"wrong-repository",
		"different-node",
		"corrupt-log",
		"different-content-with-same-head",
		"different-effective-environment",
		"missing-environment-proof",
	])("%s 不作为通过证据，检查模式只报告精确缺项", (scenario) => {
		const fixture = createValidationFixture();
		const record = fixture.addStandardRecord({
			wrongRepository: scenario === "wrong-repository",
			nodeVersion: scenario === "different-node" ? "0.0.0" : undefined,
			wrongContentManifest: scenario === "different-content-with-same-head",
			wrongEnvironment: scenario === "different-effective-environment",
			missingEnvironment: scenario === "missing-environment-proof",
		});
		if (scenario === "corrupt-log") writeFileSync(record.stdoutPath, "被改写的原件");
		const result = fixture.run({ inspectOnly: true });
		expect(result.report().sourceValidationCheckResults[0].decision).toBe("missing_check");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("保留同树最新失败，不能挑选更早成功放行", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		fixture.addStandardRecord({ failed: true });
		const result = fixture.run();
		expect(result.status).toBe(1);
		expect(result.report().sourceValidationCheckResults[0].decision).toBe("quality_validation_failed");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it.each([130, -2] as const)("SIGINT 中止记录 %s 保留为未完成，当前计划仍须实际检查", (interruptedExitCode) => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord({ interruptedExitCode });
		const inspected = fixture.run({ inspectOnly: true });
		expect(inspected.report().availableSourceValidationChecks[0].status).toBe("interrupted");
		expect(inspected.report().sourceValidationCheckResults[0].decision).toBe("missing_check");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
		const executed = fixture.run();
		expect(executed.status).toBe(0);
		expect(executed.report().sourceValidationCheckResults[0].decision).toBe("executed_missing_check");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
	});

	it("同一 operation 较晚中止不会覆盖此前真实失败", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord({ failed: true, concludedAt: "2026-11-04T00:01:00Z" });
		fixture.addStandardRecord({ interruptedExitCode: 130, concludedAt: "2026-11-04T01:01:00Z" });
		const result = fixture.run();
		expect(result.status).toBe(1);
		expect(result.report().availableSourceValidationChecks.map((check) => check.status)).toEqual([
			"failed",
			"interrupted",
		]);
		expect(result.report().sourceValidationCheckResults[0].decision).toBe("quality_validation_failed");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("备用包内容摘要与当前候选不匹配时补验，不凭相同 tree 复用", () => {
		const fixture = createValidationFixture();
		fixture.addLegacyBundle({ wrongContentManifest: true });
		const result = fixture.run({ inspectOnly: true });
		expect(result.report().sourceValidationCheckResults.map((check) => check.decision)).toEqual([
			"missing_check",
			"missing_check",
		]);
	});

	it("仓库外 wrapper 内容变化后不复用旧执行成功", () => {
		const fixture = createValidationFixture();
		const wrapper = join(fixture.fixture.fixtureRootDirectoryPath, "external-wrapper.mjs");
		writeFileSync(wrapper, "process.exit(0)\n");
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "外部包装检查", argv: [process.execPath, wrapper] }],
		});
		expect(fixture.run().status).toBe(0);
		writeFileSync(wrapper, "process.exit(1)\n");
		expect(fixture.run().status).toBe(1);
		expect(fixture.run().report().sourceValidationCheckResults[0].decision).toBe("quality_validation_failed");
	});

	it("环境漂移不解除同项存活旧进程的互斥", () => {
		const fixture = createValidationFixture();
		fixture.run();
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		state.attempts[0].status = "running";
		state.attempts[0].childProcessId = process.pid;
		state.attempts[0].childProcessStartIdentity = null;
		rmSync(state.attempts[0].nativeSupervisionPath);
		writeJson(statePath, state);
		writeFileSync(join(fixture.gitCommonDirectory, "info/exclude"), "node_modules/\n");
		mkdirSync(join(fixture.sourceCheckoutPath, "node_modules"), { recursive: true });
		writeFileSync(join(fixture.sourceCheckoutPath, "node_modules/.package-lock.json"), "{}");
		expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
	});

	it("缺 PID 但原生监督已记录退出时接续完成结果，不重复执行", () => {
		const fixture = createValidationFixture();
		fixture.run();
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		state.attempts[0].status = "running";
		delete state.attempts[0].childProcessId;
		delete state.attempts[0].childProcessStartIdentity;
		writeJson(statePath, state);
		expect(fixture.run().status).toBe(0);
		expect(fixture.run().report().sourceValidationCheckResults[0].decision).toBe("reused_previous_execution");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
		expect(JSON.parse(readFileSync(statePath, "utf8")).attempts).toHaveLength(1);
	});

	it("缺 PID 且监督记录未落盘时按唯一启动标识识别存活进程，不重复执行", () => {
		const fixture = createValidationFixture();
		fixture.run();
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		const attempt = state.attempts[0];
		const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", attempt.launchToken], {
			stdio: "ignore",
		});
		onTestFinished(() => {
			survivor.kill("SIGKILL");
		});
		attempt.status = "running";
		for (const field of [
			"childProcessId",
			"childProcessStartIdentity",
			"supervisorProcessId",
			"supervisorProcessStartIdentity",
		])
			delete attempt[field];
		rmSync(attempt.nativeSupervisionPath);
		writeJson(statePath, state);
		expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
		expect(JSON.parse(readFileSync(statePath, "utf8")).attempts).toHaveLength(1);
	});

	it("缺 PID、无监督记录且启动标识无存活进程时有界接续", () => {
		const fixture = createValidationFixture();
		fixture.run();
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		const attempt = state.attempts[0];
		attempt.status = "running";
		for (const field of [
			"childProcessId",
			"childProcessStartIdentity",
			"supervisorProcessId",
			"supervisorProcessStartIdentity",
		])
			delete attempt[field];
		rmSync(attempt.nativeSupervisionPath);
		writeJson(statePath, state);
		expect(fixture.run().status).toBe(0);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n检查\n");
		expect(JSON.parse(readFileSync(statePath, "utf8")).attempts).toHaveLength(2);
	});

	it("监督已退出且子 PID 未落盘时按原生进程组等待，组内进程退出后无需重启即可接续", async () => {
		const fixture = createValidationFixture();
		fixture.run();
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		const attempt = state.attempts[0];
		const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
			detached: true,
			stdio: "ignore",
		});
		const survivorProcessId = survivor.pid;
		if (!survivorProcessId) throw new Error("隔离进程组未能启动");
		onTestFinished(() => {
			try {
				process.kill(-survivorProcessId, "SIGKILL");
			} catch {}
		});
		attempt.status = "running";
		delete attempt.childProcessId;
		delete attempt.childProcessStartIdentity;
		const supervision = JSON.parse(readFileSync(attempt.nativeSupervisionPath, "utf8"));
		Object.assign(supervision, {
			status: "running",
			supervisorProcessId: survivorProcessId,
			supervisorProcessStartIdentity: "已退出的监督进程",
			processGroupId: survivorProcessId,
		});
		delete supervision.childProcessId;
		delete supervision.childProcessStartIdentity;
		writeJson(attempt.nativeSupervisionPath, supervision);
		writeJson(statePath, state);
		expect(fixture.run().summary.status).toBe("machine_evidence_pending");
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n");
		const runningObservation = fixture.run({ observeRecovery: true }).summary.evidenceSha256;
		const exited = new Promise<void>((resolveExit) => survivor.once("exit", () => resolveExit()));
		survivor.kill("SIGKILL");
		await exited;
		expect(fixture.run({ observeRecovery: true }).summary.evidenceSha256).not.toBe(runningObservation);
		expect(fixture.run().status).toBe(0);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n检查\n");
		expect(JSON.parse(readFileSync(statePath, "utf8")).attempts).toHaveLength(2);
	});

	it("监督已退出且子 PID 未落盘时，明确未启动的空进程组可直接接续", async () => {
		const fixture = createValidationFixture();
		fixture.run();
		const exitedSupervisor = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
		const exitedSupervisorProcessId = exitedSupervisor.pid;
		if (!exitedSupervisorProcessId) throw new Error("空进程组未能启动");
		const exitCode = await new Promise<number | null>((resolveExit, reject) => {
			exitedSupervisor.once("error", reject);
			exitedSupervisor.once("exit", resolveExit);
		});
		expect(exitCode).toBe(0);
		const statePath = join(fixture.output, "source-validation-execution-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		const attempt = state.attempts[0];
		attempt.status = "running";
		delete attempt.childProcessId;
		delete attempt.childProcessStartIdentity;
		const supervision = JSON.parse(readFileSync(attempt.nativeSupervisionPath, "utf8"));
		Object.assign(supervision, {
			status: "running",
			supervisorProcessId: exitedSupervisorProcessId,
			supervisorProcessStartIdentity: "已退出的监督进程",
			processGroupId: exitedSupervisorProcessId,
		});
		delete supervision.childProcessId;
		delete supervision.childProcessStartIdentity;
		writeJson(attempt.nativeSupervisionPath, supervision);
		writeJson(statePath, state);
		expect(fixture.run().status).toBe(0);
		expect(readFileSync(fixture.executedSourceValidationCounterPath, "utf8")).toBe("检查\n检查\n");
		expect(JSON.parse(readFileSync(statePath, "utf8")).attempts).toHaveLength(2);
	});

	it("跨 operation 以明确较晚成功替代旧失败", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord({
			failed: true,
			operationName: "z-old-failure",
			concludedAt: "2026-11-04T00:01:00Z",
		});
		fixture.addStandardRecord({
			operationName: "a-new-pass",
			startedAt: "2026-11-04T01:00:00Z",
			concludedAt: "2026-11-04T01:01:00Z",
		});
		expect(fixture.run().status).toBe(0);
		expect(fixture.run().summary.reusedSourceValidationCheckCount).toBe(1);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("历史失败原件清理后仍持久阻止自动重跑", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord({ failed: true, concludedAt: "2026-11-04T00:01:00Z" });
		expect(fixture.run().status).toBe(1);
		rmSync(join(fixture.gitCommonDirectory, "base-branch-sync"), { recursive: true });
		expect(fixture.run().status).toBe(1);
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("RVF 首个命令真实失败时保留失败，不采用更早通过", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord({ concludedAt: "2026-11-04T00:00:00Z" });
		const runDirectory = join(
			fixture.fixture.isolatedHomeDirectoryPath,
			".rvf/user-local-data/task-snapshot-reviews/failed-rvf-run",
		);
		const commandDirectory = join(runDirectory, "final-validation/attempt-001/command-001");
		const executionPlanPath = join(runDirectory, "execution-plan.json");
		writeJson(executionPlanPath, {
			validation_commands: [fixture.command.argv],
			machine_context: { task_id: "rvf-producer-task", native_node: process.execPath },
		});
		writeJson(join(runDirectory, "run.json"), {
			schema_version: 1,
			run_id: "failed-rvf-run",
			git_common_directory: fixture.gitCommonDirectory,
			validated_candidate_commit: fixture.commit,
			execution_plan_sha256: digest(readFileSync(executionPlanPath)),
		});
		writeJson(join(runDirectory, "validation.json"), {
			status: "failed",
			returncode: 1,
			candidate_commit: fixture.commit,
			tested_tree: fixture.tree,
			commands: [fixture.command.argv],
			completed_commands: 0,
			attempt_directory: join(runDirectory, "final-validation/attempt-001"),
		});
		writeJson(join(commandDirectory, "execution.json"), {
			argv: fixture.command.argv,
			cwd: fixture.sourceCheckoutPath,
			source_tree_before: fixture.tree,
			source_tree_after: fixture.tree,
			status: "failed",
			returncode: 1,
			finished_at: "2026-11-04T01:00:00Z",
		});
		writeFileSync(join(commandDirectory, "stdout.txt"), "");
		writeFileSync(join(commandDirectory, "stderr.txt"), "失败\n");
		writeJson(join(commandDirectory, "command-supervision.json"), {
			argv: fixture.command.argv,
			status: "completed",
			owned_process_exit_status: "exited",
			command_execution_started: true,
			returncode: 1,
			stdout_sha256: digest(""),
			stderr_sha256: digest("失败\n"),
		});
		expect(fixture.run().status).toBe(1);
		expect(fixture.run().report().sourceValidationCheckResults[0].decision).toBe("quality_validation_failed");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("源码含 WIP 或候选不是完整固定 SHA 时不消费旧通过", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		writeFileSync(join(fixture.sourceCheckoutPath, "candidate-source.txt"), "未经验证的改动");
		expect(fixture.run().summary.reason).toContain("WIP");
		expect(fixture.run({ commit: "HEAD" }).summary.reason).toContain("完整 commit SHA");
		expect(existsSync(fixture.executedSourceValidationCounterPath)).toBe(false);
	});

	it("源码提交树前移不复用旧记录，同名覆盖也不能替代不同 argv", () => {
		const fixture = createValidationFixture();
		fixture.addStandardRecord();
		writeFileSync(join(fixture.sourceCheckoutPath, "candidate-source.txt"), "新的候选\n");
		const nextCommit = fixture.repository.commitAllRepositoryFilesAtDate({
			message: "候选前移",
			authorAndCommitterIsoDate: "2026-11-05T00:00:00Z",
		});
		expect(
			fixture.run({ commit: nextCommit, inspectOnly: true }).report().sourceValidationCheckResults[0].decision,
		).toBe("missing_check");
	});

	it("验证计划不得借源码验证入口执行构建或部署", () => {
		const fixture = createValidationFixture();
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "越界操作", argv: ["npm", "run", "build"] }],
		});
		expect(fixture.run().summary.reason).toContain("不得构建");
		writeJson(fixture.planPath, {
			schemaVersion: 1,
			commands: [{ name: "同样越界", argv: ["/usr/bin/env", "EXAMPLE=1", "npm", "run", "build"] }],
		});
		expect(fixture.run().summary.reason).toContain("不得构建");
	});
});
