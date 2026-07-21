import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InvokingRepositoryMutationCategory =
	| "worktree-identity"
	| "git-directory-identity"
	| "common-git-directory-identity"
	| "symbolic-head"
	| "head-oid"
	| "local-config"
	| "index"
	| "working-tree-status";

export interface InvokingRepositoryEvidenceSnapshot {
	invokingWorktreePath: string;
	absoluteGitDirectoryPath: string;
	absoluteCommonGitDirectoryPath: string;
	symbolicHead: string | null;
	headObjectId: string | null;
	localConfigFilePath: string;
	localConfigSha256: string | null;
	indexFilePath: string;
	indexSha256: string | null;
	porcelainVersionTwoStatus: string;
	workingTreeContentEvidenceSha256: string;
}

export interface InvokingRepositoryMutationCanaryRunResult {
	exitCode: number;
	originalChildExitCode: number | null;
	originalChildSignal: NodeJS.Signals | null;
	mutationCategories: InvokingRepositoryMutationCategory[];
	diagnosticReportPath: string | null;
}

interface SpawnedCommandCompletion {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
	SIGINT: 130,
	SIGTERM: 143,
};
const ALL_INVOKING_REPOSITORY_MUTATION_CATEGORIES: readonly InvokingRepositoryMutationCategory[] = [
	"worktree-identity",
	"git-directory-identity",
	"common-git-directory-identity",
	"symbolic-head",
	"head-oid",
	"local-config",
	"index",
	"working-tree-status",
];

function createGitEnvironmentWithoutInheritedRepositoryLocationVariables(): NodeJS.ProcessEnv {
	const environmentVariables: NodeJS.ProcessEnv = {};
	for (const [environmentVariableName, environmentVariableValue] of Object.entries(process.env)) {
		if (!environmentVariableName.toUpperCase().startsWith("GIT_")) {
			environmentVariables[environmentVariableName] = environmentVariableValue;
		}
	}
	environmentVariables.GIT_CONFIG_NOSYSTEM = "1";
	environmentVariables.GIT_TERMINAL_PROMPT = "0";
	return environmentVariables;
}

function runGitEvidenceCommand(options: {
	workingDirectoryPath: string;
	arguments: readonly string[];
	expectedExitCodes?: readonly number[];
}): Buffer {
	const expectedExitCodes = options.expectedExitCodes ?? [0];
	const result = spawnSync("git", [...options.arguments], {
		cwd: options.workingDirectoryPath,
		env: createGitEnvironmentWithoutInheritedRepositoryLocationVariables(),
		encoding: null,
		maxBuffer: 16 * 1024 * 1024,
	});
	const exitCode = result.status ?? 1;
	if (!expectedExitCodes.includes(exitCode)) {
		throw new Error(
			`Invoking repository evidence command failed: git ${options.arguments.join(" ")} (exit ${exitCode})\n${String(result.stderr)}`,
		);
	}
	return result.stdout;
}

function resolveGitReportedPath(invokingWorktreePath: string, reportedPath: string): string {
	return realpathSync(isAbsolute(reportedPath) ? reportedPath : resolve(invokingWorktreePath, reportedPath));
}

function readOptionalFileSha256(filePath: string): string | null {
	if (!existsSync(filePath)) {
		return null;
	}
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function buildWorkingTreeContentEvidenceSha256(invokingWorktreePath: string): string {
	const evidenceHash = createHash("sha256");
	evidenceHash.update(
		runGitEvidenceCommand({
			workingDirectoryPath: invokingWorktreePath,
			arguments: ["diff", "--binary", "HEAD", "--"],
			expectedExitCodes: [0, 128],
		}),
	);
	const untrackedPaths = runGitEvidenceCommand({
		workingDirectoryPath: invokingWorktreePath,
		arguments: ["ls-files", "--others", "--exclude-standard", "-z"],
	})
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.sort();
	for (const repositoryRelativePath of untrackedPaths) {
		const absolutePath = resolve(invokingWorktreePath, repositoryRelativePath);
		evidenceHash.update(`${repositoryRelativePath}\0`);
		const filesystemEntry = lstatSync(absolutePath);
		if (filesystemEntry.isSymbolicLink()) {
			evidenceHash.update(`symlink\0${readlinkSync(absolutePath)}\0`);
		} else if (filesystemEntry.isFile()) {
			evidenceHash.update(`file\0${filesystemEntry.mode}\0`).update(readFileSync(absolutePath));
		} else {
			evidenceHash.update(`other\0${filesystemEntry.mode}\0`);
		}
	}
	return evidenceHash.digest("hex");
}

function readTrimmedGitEvidenceText(options: {
	workingDirectoryPath: string;
	arguments: readonly string[];
	expectedExitCodes?: readonly number[];
}): string {
	return runGitEvidenceCommand(options).toString("utf8").trim();
}

export function captureInvokingRepositoryEvidenceSnapshot(
	invokingDirectoryPath: string,
): InvokingRepositoryEvidenceSnapshot {
	const invokingWorktreePath = realpathSync(
		readTrimmedGitEvidenceText({
			workingDirectoryPath: invokingDirectoryPath,
			arguments: ["rev-parse", "--show-toplevel"],
		}),
	);
	const absoluteGitDirectoryPath = resolveGitReportedPath(
		invokingWorktreePath,
		readTrimmedGitEvidenceText({
			workingDirectoryPath: invokingWorktreePath,
			arguments: ["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
		}),
	);
	const absoluteCommonGitDirectoryPath = resolveGitReportedPath(
		invokingWorktreePath,
		readTrimmedGitEvidenceText({
			workingDirectoryPath: invokingWorktreePath,
			arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
		}),
	);
	const symbolicHeadOutput = readTrimmedGitEvidenceText({
		workingDirectoryPath: invokingWorktreePath,
		arguments: ["symbolic-ref", "--quiet", "HEAD"],
		expectedExitCodes: [0, 1],
	});
	const headObjectIdOutput = readTrimmedGitEvidenceText({
		workingDirectoryPath: invokingWorktreePath,
		arguments: ["rev-parse", "--verify", "HEAD"],
		expectedExitCodes: [0, 128],
	});
	const localConfigFilePath = resolveGitReportedPath(
		invokingWorktreePath,
		readTrimmedGitEvidenceText({
			workingDirectoryPath: invokingWorktreePath,
			arguments: ["rev-parse", "--path-format=absolute", "--git-path", "config"],
		}),
	);
	const indexFilePathOutput = readTrimmedGitEvidenceText({
		workingDirectoryPath: invokingWorktreePath,
		arguments: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
	});
	const indexFilePath = isAbsolute(indexFilePathOutput)
		? indexFilePathOutput
		: resolve(invokingWorktreePath, indexFilePathOutput);

	const porcelainVersionTwoStatus = runGitEvidenceCommand({
		workingDirectoryPath: invokingWorktreePath,
		arguments: ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
	}).toString("utf8");

	return {
		invokingWorktreePath,
		absoluteGitDirectoryPath,
		absoluteCommonGitDirectoryPath,
		symbolicHead: symbolicHeadOutput || null,
		headObjectId: headObjectIdOutput || null,
		localConfigFilePath,
		localConfigSha256: readOptionalFileSha256(localConfigFilePath),
		indexFilePath,
		indexSha256: readOptionalFileSha256(indexFilePath),
		porcelainVersionTwoStatus,
		workingTreeContentEvidenceSha256: buildWorkingTreeContentEvidenceSha256(invokingWorktreePath),
	};
}

export function compareInvokingRepositoryEvidenceSnapshots(
	before: InvokingRepositoryEvidenceSnapshot,
	after: InvokingRepositoryEvidenceSnapshot,
): InvokingRepositoryMutationCategory[] {
	const changedCategories: InvokingRepositoryMutationCategory[] = [];
	if (before.invokingWorktreePath !== after.invokingWorktreePath) changedCategories.push("worktree-identity");
	if (before.absoluteGitDirectoryPath !== after.absoluteGitDirectoryPath) {
		changedCategories.push("git-directory-identity");
	}
	if (before.absoluteCommonGitDirectoryPath !== after.absoluteCommonGitDirectoryPath) {
		changedCategories.push("common-git-directory-identity");
	}
	if (before.symbolicHead !== after.symbolicHead) changedCategories.push("symbolic-head");
	if (before.headObjectId !== after.headObjectId) changedCategories.push("head-oid");
	if (before.localConfigSha256 !== after.localConfigSha256) changedCategories.push("local-config");
	if (before.indexSha256 !== after.indexSha256) changedCategories.push("index");
	if (
		before.porcelainVersionTwoStatus !== after.porcelainVersionTwoStatus ||
		before.workingTreeContentEvidenceSha256 !== after.workingTreeContentEvidenceSha256
	) {
		changedCategories.push("working-tree-status");
	}
	return changedCategories;
}

function createIsolatedChildTestEnvironment(diagnosticDirectoryPath: string): NodeJS.ProcessEnv {
	const isolatedHomeDirectoryPath = join(diagnosticDirectoryPath, "isolated-child-home");
	const isolatedXdgConfigDirectoryPath = join(diagnosticDirectoryPath, "isolated-child-xdg-config");
	const isolatedTemporaryDirectoryPath = join(diagnosticDirectoryPath, "isolated-child-temporary-files");
	for (const directoryPath of [
		isolatedHomeDirectoryPath,
		isolatedXdgConfigDirectoryPath,
		isolatedTemporaryDirectoryPath,
	]) {
		mkdirSync(directoryPath, { recursive: true });
	}
	const environmentVariables = createGitEnvironmentWithoutInheritedRepositoryLocationVariables();
	return {
		...environmentVariables,
		HOME: isolatedHomeDirectoryPath,
		USERPROFILE: isolatedHomeDirectoryPath,
		XDG_CONFIG_HOME: isolatedXdgConfigDirectoryPath,
		TMPDIR: isolatedTemporaryDirectoryPath,
		TEMP: isolatedTemporaryDirectoryPath,
		TMP: isolatedTemporaryDirectoryPath,
		GIT_CONFIG_GLOBAL: join(isolatedHomeDirectoryPath, ".gitconfig"),
	};
}

function spawnCommandAndForwardTerminationSignals(options: {
	command: string;
	arguments: readonly string[];
	workingDirectoryPath: string;
	environmentVariables: NodeJS.ProcessEnv;
}): Promise<SpawnedCommandCompletion> {
	return new Promise((resolveCompletion, rejectCompletion) => {
		const childProcess = spawn(options.command, [...options.arguments], {
			cwd: options.workingDirectoryPath,
			env: options.environmentVariables,
			stdio: "inherit",
		});
		const forwardedSignalHandlers = new Map<NodeJS.Signals, () => void>();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const handler = () => {
				if (childProcess.exitCode === null && childProcess.signalCode === null) {
					childProcess.kill(signal);
				}
			};
			forwardedSignalHandlers.set(signal, handler);
			process.on(signal, handler);
		}
		const removeSignalHandlers = () => {
			for (const [signal, handler] of forwardedSignalHandlers) {
				process.removeListener(signal, handler);
			}
		};
		childProcess.once("error", (error) => {
			removeSignalHandlers();
			rejectCompletion(error);
		});
		childProcess.once("close", (exitCode, signal) => {
			removeSignalHandlers();
			resolveCompletion({ exitCode, signal });
		});
	});
}

function writeMutationDiagnosticReport(options: {
	diagnosticDirectoryPath: string;
	before: InvokingRepositoryEvidenceSnapshot;
	after: InvokingRepositoryEvidenceSnapshot | null;
	mutationCategories: readonly InvokingRepositoryMutationCategory[];
	childCompletion: SpawnedCommandCompletion;
}): string {
	const diagnosticReportPath = join(options.diagnosticDirectoryPath, "invoking-repository-mutation-report.json");
	writeFileSync(
		diagnosticReportPath,
		`${JSON.stringify(
			{
				mutationCategories: options.mutationCategories,
				originalChildExitCode: options.childCompletion.exitCode,
				originalChildSignal: options.childCompletion.signal,
				before: options.before,
				after: options.after,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return diagnosticReportPath;
}

export async function runCommandWithInvokingRepositoryMutationCanary(options: {
	invokingDirectoryPath: string;
	command: string;
	arguments?: readonly string[];
}): Promise<InvokingRepositoryMutationCanaryRunResult> {
	const before = captureInvokingRepositoryEvidenceSnapshot(options.invokingDirectoryPath);
	const diagnosticDirectoryPath = mkdtempSync(join(tmpdir(), "cline-kanban-invoking-repository-canary-"));
	let childCompletion: SpawnedCommandCompletion;
	try {
		childCompletion = await spawnCommandAndForwardTerminationSignals({
			command: options.command,
			arguments: options.arguments ?? [],
			workingDirectoryPath: before.invokingWorktreePath,
			environmentVariables: createIsolatedChildTestEnvironment(diagnosticDirectoryPath),
		});
	} catch {
		childCompletion = { exitCode: 1, signal: null };
	}
	let after: InvokingRepositoryEvidenceSnapshot | null = null;
	try {
		after = captureInvokingRepositoryEvidenceSnapshot(before.invokingWorktreePath);
	} catch {
		after = null;
	}
	const mutationCategories: InvokingRepositoryMutationCategory[] = after
		? compareInvokingRepositoryEvidenceSnapshots(before, after)
		: [...ALL_INVOKING_REPOSITORY_MUTATION_CATEGORIES];
	if (mutationCategories.length > 0) {
		const diagnosticReportPath = writeMutationDiagnosticReport({
			diagnosticDirectoryPath,
			before,
			after,
			mutationCategories,
			childCompletion,
		});
		return {
			exitCode: 1,
			originalChildExitCode: childCompletion.exitCode,
			originalChildSignal: childCompletion.signal,
			mutationCategories,
			diagnosticReportPath,
		};
	}
	rmSync(diagnosticDirectoryPath, { recursive: true, force: false });
	return {
		exitCode:
			childCompletion.exitCode ?? (childCompletion.signal ? (SIGNAL_EXIT_CODES[childCompletion.signal] ?? 1) : 1),
		originalChildExitCode: childCompletion.exitCode,
		originalChildSignal: childCompletion.signal,
		mutationCategories,
		diagnosticReportPath: null,
	};
}

async function runInvokingRepositoryMutationCanaryCommand(): Promise<void> {
	const argumentSeparatorIndex = process.argv.indexOf("--", 2);
	const commandArguments =
		argumentSeparatorIndex >= 0 ? process.argv.slice(argumentSeparatorIndex + 1) : process.argv.slice(2);
	const command = commandArguments[0];
	if (!command) {
		throw new Error(
			"Usage: tsx test/git-repository-mutation-safety/run-test-projects-with-invoking-repository-mutation-canary.ts -- <command> [args...]",
		);
	}
	const result = await runCommandWithInvokingRepositoryMutationCanary({
		invokingDirectoryPath: process.cwd(),
		command,
		arguments: commandArguments.slice(1),
	});
	if (result.mutationCategories.length > 0) {
		process.stderr.write(
			`检测到 invoking repository 漂移：${result.mutationCategories.join(", ")}。未执行自动恢复。\n`,
		);
		process.stderr.write(`脱敏诊断报告：${result.diagnosticReportPath ?? "unavailable"}\n`);
		if (result.originalChildExitCode !== null || result.originalChildSignal !== null) {
			process.stderr.write(
				`原测试进程结果：exit=${String(result.originalChildExitCode)} signal=${String(result.originalChildSignal)}\n`,
			);
		}
	}
	process.exitCode = result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void runInvokingRepositoryMutationCanaryCommand().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}
