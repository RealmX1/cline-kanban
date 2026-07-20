import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface IsolatedGitTestRepository {
	repositoryPath: string;
	runGit(
		arguments_: readonly string[],
		options?: {
			workingDirectoryPath?: string;
			expectedExitCodes?: readonly number[];
			environmentVariableOverrides?: NodeJS.ProcessEnv;
		},
	): GitCommandResult;
	createLinkedWorktree(options: { worktreeDirectoryName: string; branchName: string; startPoint?: string }): {
		worktreePath: string;
	};
}

export interface IsolatedGitTestWorkspaceFixture {
	fixtureRootDirectoryPath: string;
	isolatedHomeDirectoryPath: string;
	ownedIntegrationProjectsDirectoryPath: string;
	createIsolatedChildProcessEnvironment(environmentVariableOverrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	createNonBareRepository(options: {
		repositoryDirectoryName: string;
		initialBranchName?: string;
	}): IsolatedGitTestRepository;
	createNonBareRepositoryAtOwnedPath(options: {
		repositoryPath: string;
		initialBranchName?: string;
	}): IsolatedGitTestRepository;
	createBareRepository(options: { repositoryDirectoryName: string }): IsolatedGitTestRepository;
	cleanup(): void;
}

interface FilesystemIdentity {
	device: number;
	inode: number;
	realPath: string;
}

const ISOLATION_OWNED_ENVIRONMENT_VARIABLE_NAMES = new Set([
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
]);
const ALLOWED_PER_COMMAND_GIT_ENVIRONMENT_VARIABLE_NAMES = new Set(["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]);
const GIT_REPOSITORY_REDIRECTION_ARGUMENT_PREFIXES = [
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--config-env",
	"--exec-path",
	"--pathspec-from-file",
	"--upload-pack",
	"--receive-pack",
	"--ssh-command",
];

function isPathInsideOrEqualToRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath = relative(rootPath, candidatePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function assertSimpleDirectoryName(directoryName: string, description: string): void {
	if (!directoryName || directoryName === "." || directoryName === ".." || basename(directoryName) !== directoryName) {
		throw new Error(`${description} must be one non-empty directory name without path separators`);
	}
}

function captureFilesystemIdentity(path: string): FilesystemIdentity {
	const entry = lstatSync(path);
	return { device: entry.dev, inode: entry.ino, realPath: realpathSync(path) };
}

function redactGitDiagnosticText(text: string): string {
	return text
		.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/giu, "$1[redacted]@")
		.replace(/((?:api[_-]?key|credential|password|token)\s*[=:]\s*)\S+/giu, "$1[redacted]");
}

function formatGitCommand(arguments_: readonly string[]): string {
	return ["git", ...arguments_]
		.map((argument) => redactGitDiagnosticText(argument))
		.map((argument) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(argument) ? argument : JSON.stringify(argument)))
		.join(" ");
}

export function createIsolatedGitTestWorkspaceFixture(): IsolatedGitTestWorkspaceFixture {
	const fixtureRootDirectoryPath = mkdtempSync(
		join(realpathSync(tmpdir()), "cline-kanban-isolated-git-test-workspace-"),
	);
	const fixtureRootIdentity = captureFilesystemIdentity(fixtureRootDirectoryPath);
	const protectedSiblingSentinelPath = `${fixtureRootDirectoryPath}.protected-sibling-sentinel`;
	const protectedSiblingSentinelContents = `protected-sibling:${basename(fixtureRootDirectoryPath)}\n`;
	writeFileSync(protectedSiblingSentinelPath, protectedSiblingSentinelContents, { flag: "wx" });
	const protectedSiblingSentinelIdentity = captureFilesystemIdentity(protectedSiblingSentinelPath);

	const isolatedHomeDirectoryPath = join(fixtureRootDirectoryPath, "isolated-home-directory");
	const isolatedXdgConfigDirectoryPath = join(fixtureRootDirectoryPath, "isolated-xdg-config-directory");
	const isolatedTemporaryDirectoryPath = join(fixtureRootDirectoryPath, "isolated-temporary-directory");
	const repositoriesDirectoryPath = join(fixtureRootDirectoryPath, "isolated-git-repositories");
	const linkedWorktreesDirectoryPath = join(fixtureRootDirectoryPath, "isolated-linked-worktrees");
	const ownedIntegrationProjectsDirectoryPath = join(fixtureRootDirectoryPath, "owned-integration-projects");
	const disabledGitHooksDirectoryPath = join(fixtureRootDirectoryPath, "disabled-git-hooks-directory");
	for (const directoryPath of [
		isolatedHomeDirectoryPath,
		isolatedXdgConfigDirectoryPath,
		isolatedTemporaryDirectoryPath,
		repositoriesDirectoryPath,
		linkedWorktreesDirectoryPath,
		ownedIntegrationProjectsDirectoryPath,
		disabledGitHooksDirectoryPath,
	]) {
		mkdirSync(directoryPath);
	}
	const isolatedGlobalGitConfigPath = join(isolatedHomeDirectoryPath, ".gitconfig");
	writeFileSync(isolatedGlobalGitConfigPath, "");

	const isolatedGitEnvironment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.toUpperCase().startsWith("GIT_")) isolatedGitEnvironment[name] = value;
	}
	Object.assign(isolatedGitEnvironment, {
		HOME: isolatedHomeDirectoryPath,
		USERPROFILE: isolatedHomeDirectoryPath,
		XDG_CONFIG_HOME: isolatedXdgConfigDirectoryPath,
		TMPDIR: isolatedTemporaryDirectoryPath,
		TEMP: isolatedTemporaryDirectoryPath,
		TMP: isolatedTemporaryDirectoryPath,
		GIT_AUTHOR_NAME: "Cline Kanban Isolated Git Test Author",
		GIT_AUTHOR_EMAIL: "isolated-git-test-author@example.invalid",
		GIT_COMMITTER_NAME: "Cline Kanban Isolated Git Test Committer",
		GIT_COMMITTER_EMAIL: "isolated-git-test-committer@example.invalid",
		GIT_CONFIG_GLOBAL: isolatedGlobalGitConfigPath,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: disabledGitHooksDirectoryPath,
	});

	const registeredRepositoryPaths = new Set<string>();
	let cleanupCompleted = false;

	function assertExistingPathInsideFixture(path: string, description: string): string {
		const realPath = realpathSync(path);
		if (!isPathInsideOrEqualToRoot(realPath, fixtureRootIdentity.realPath)) {
			throw new Error(`${description} escaped isolated Git fixture root: ${realPath}`);
		}
		return realPath;
	}

	function assertPotentialPathInsideFixture(path: string, description: string): string {
		const absolutePath = resolve(path);
		let existingAncestorPath = absolutePath;
		while (!existsSync(existingAncestorPath)) {
			const parentPath = dirname(existingAncestorPath);
			if (parentPath === existingAncestorPath)
				throw new Error(`${description} has no existing ancestor: ${absolutePath}`);
			existingAncestorPath = parentPath;
		}
		assertExistingPathInsideFixture(existingAncestorPath, `${description} ancestor`);
		if (!isPathInsideOrEqualToRoot(absolutePath, fixtureRootIdentity.realPath)) {
			throw new Error(`${description} escaped isolated Git fixture root: ${absolutePath}`);
		}
		return absolutePath;
	}

	function executeGit(options: {
		arguments_: readonly string[];
		workingDirectoryPath: string;
		expectedExitCodes?: readonly number[];
		environmentVariableOverrides?: NodeJS.ProcessEnv;
	}): GitCommandResult {
		const expectedExitCodes = options.expectedExitCodes ?? [0];
		const environment: NodeJS.ProcessEnv = { ...isolatedGitEnvironment };
		for (const [name, value] of Object.entries(options.environmentVariableOverrides ?? {})) {
			if (!ALLOWED_PER_COMMAND_GIT_ENVIRONMENT_VARIABLE_NAMES.has(name)) {
				throw new Error(`Git command environment variable ${name} is not allowed by the isolated fixture`);
			}
			if (value === undefined) delete environment[name];
			else environment[name] = value;
		}
		const workingDirectoryPath = assertExistingPathInsideFixture(options.workingDirectoryPath, "Git command cwd");
		const result = spawnSync("git", [...options.arguments_], {
			cwd: workingDirectoryPath,
			encoding: "utf8",
			env: environment,
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
		});
		if (result.error)
			throw new Error(`Could not run ${formatGitCommand(options.arguments_)}: ${result.error.message}`);
		const commandResult = { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
		if (!expectedExitCodes.includes(commandResult.exitCode)) {
			throw new Error(
				`Isolated Git command failed\ncommand: ${formatGitCommand(options.arguments_)}\ncwd: ${workingDirectoryPath}\nexitCode: ${commandResult.exitCode}\nstdout:\n${redactGitDiagnosticText(commandResult.stdout)}\nstderr:\n${redactGitDiagnosticText(commandResult.stderr)}`,
			);
		}
		return commandResult;
	}

	function assertRemoteUrlInsideFixture(repositoryPath: string, remoteUrl: string): void {
		if (/^[a-z][a-z\d+.-]*:\/\//iu.test(remoteUrl) && !remoteUrl.startsWith("file://")) {
			throw new Error("Configured Git remote URL must be fixture-local");
		}
		if (/^[^/]+:.+/u.test(remoteUrl) && !remoteUrl.startsWith("file://")) {
			throw new Error("Configured Git remote URL must be fixture-local");
		}
		const path = remoteUrl.startsWith("file://") ? fileURLToPath(remoteUrl) : resolve(repositoryPath, remoteUrl);
		assertExistingPathInsideFixture(path, "Configured Git remote");
	}

	function assertRepositoryInsideFixture(repositoryPath: string): void {
		assertExistingPathInsideFixture(repositoryPath, "Registered Git repository");
		const [gitDirectoryPath, commonDirectoryPath] = executeGit({
			arguments_: ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
			workingDirectoryPath: repositoryPath,
		})
			.stdout.trim()
			.split("\n");
		if (!gitDirectoryPath || !commonDirectoryPath)
			throw new Error("Git metadata discovery returned incomplete paths");
		assertExistingPathInsideFixture(gitDirectoryPath, "Git directory");
		assertExistingPathInsideFixture(commonDirectoryPath, "Git common directory");

		const worktreeList = executeGit({
			arguments_: ["--git-dir", gitDirectoryPath, "worktree", "list", "--porcelain"],
			workingDirectoryPath: repositoryPath,
		}).stdout;
		for (const line of worktreeList.split("\n")) {
			if (line.startsWith("worktree ")) assertPotentialPathInsideFixture(line.slice(9), "Registered Git worktree");
		}

		for (const [configurationName, basePath] of [
			["core.worktree", gitDirectoryPath],
			["core.hooksPath", repositoryPath],
		] as const) {
			const configuredPath = executeGit({
				arguments_: ["config", "--local", "--get", configurationName],
				workingDirectoryPath: repositoryPath,
				expectedExitCodes: [0, 1],
			}).stdout.trim();
			if (configuredPath) assertPotentialPathInsideFixture(resolve(basePath, configuredPath), configurationName);
		}

		const remoteConfiguration = executeGit({
			arguments_: ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
			workingDirectoryPath: repositoryPath,
			expectedExitCodes: [0, 1],
		}).stdout;
		for (const line of remoteConfiguration.split("\n").filter(Boolean)) {
			assertRemoteUrlInsideFixture(repositoryPath, line.slice(line.search(/\s/u)).trim());
		}

		const alternatesPath = join(commonDirectoryPath, "objects", "info", "alternates");
		if (existsSync(alternatesPath)) {
			for (const path of readFileSync(alternatesPath, "utf8").split("\n").filter(Boolean)) {
				assertExistingPathInsideFixture(resolve(dirname(alternatesPath), path), "Alternate object directory");
			}
		}
	}

	function assertAllRepositoriesInsideFixture(): void {
		for (const repositoryPath of registeredRepositoryPaths) assertRepositoryInsideFixture(repositoryPath);
	}

	function assertUserGitArgumentsStayInsideFixture(repositoryPath: string, arguments_: readonly string[]): void {
		const redirectingArgument = arguments_.find((argument) =>
			GIT_REPOSITORY_REDIRECTION_ARGUMENT_PREFIXES.some(
				(prefix) => argument === prefix || argument.startsWith(`${prefix}=`),
			),
		);
		if (redirectingArgument) throw new Error(`Git argument ${redirectingArgument} can redirect outside the fixture`);
		if (arguments_[0] === "worktree" && arguments_[1] !== "list") {
			throw new Error("Use createLinkedWorktree for Git worktree mutations");
		}
		if (
			arguments_[0] === "config" &&
			arguments_.some((argument) => ["--file", "--system", "--worktree", "--blob"].includes(argument))
		) {
			throw new Error("Git config cannot address configuration outside the isolated repository");
		}
		if (arguments_[0] === "remote" && ["add", "set-url"].includes(arguments_[1] ?? "")) {
			const remoteUrl = arguments_.at(-1);
			if (remoteUrl) assertRemoteUrlInsideFixture(repositoryPath, remoteUrl);
		}
		if (["fetch", "ls-remote", "pull", "push"].includes(arguments_[0] ?? "")) {
			const target = arguments_.slice(1).find((argument) => !argument.startsWith("-"));
			const remoteNames = new Set(
				executeGit({ arguments_: ["remote"], workingDirectoryPath: repositoryPath })
					.stdout.split("\n")
					.filter(Boolean),
			);
			if (target && !remoteNames.has(target)) {
				throw new Error(`Git ${arguments_[0]} may only target a configured fixture-local remote name: ${target}`);
			}
		}
	}

	function createRepositoryHandle(repositoryPath: string): IsolatedGitTestRepository {
		return {
			repositoryPath,
			runGit(arguments_, options = {}) {
				assertUserGitArgumentsStayInsideFixture(repositoryPath, arguments_);
				const result = executeGit({
					arguments_,
					workingDirectoryPath: options.workingDirectoryPath ?? repositoryPath,
					expectedExitCodes: options.expectedExitCodes,
					environmentVariableOverrides: options.environmentVariableOverrides,
				});
				assertAllRepositoriesInsideFixture();
				return result;
			},
			createLinkedWorktree(options) {
				assertSimpleDirectoryName(options.worktreeDirectoryName, "worktreeDirectoryName");
				const worktreePath = assertPotentialPathInsideFixture(
					join(linkedWorktreesDirectoryPath, options.worktreeDirectoryName),
					"Linked worktree target",
				);
				if (existsSync(worktreePath)) throw new Error(`Linked worktree target already exists: ${worktreePath}`);
				const arguments_ = ["worktree", "add", "--quiet", "-b", options.branchName, worktreePath];
				if (options.startPoint) arguments_.push(options.startPoint);
				executeGit({ arguments_, workingDirectoryPath: repositoryPath });
				assertRepositoryInsideFixture(repositoryPath);
				return { worktreePath };
			},
		};
	}

	function registerRepository(repositoryPath: string): IsolatedGitTestRepository {
		const realPath = assertExistingPathInsideFixture(repositoryPath, "Initialized Git repository");
		registeredRepositoryPaths.add(realPath);
		assertRepositoryInsideFixture(realPath);
		return createRepositoryHandle(realPath);
	}

	function cleanup(): void {
		if (cleanupCompleted) return;
		const currentRootIdentity = captureFilesystemIdentity(fixtureRootDirectoryPath);
		if (
			currentRootIdentity.realPath !== fixtureRootIdentity.realPath ||
			currentRootIdentity.device !== fixtureRootIdentity.device ||
			currentRootIdentity.inode !== fixtureRootIdentity.inode ||
			!statSync(fixtureRootDirectoryPath).isDirectory()
		) {
			throw new Error(`Refusing cleanup because fixture root identity changed: ${fixtureRootDirectoryPath}`);
		}
		const currentSentinelIdentity = captureFilesystemIdentity(protectedSiblingSentinelPath);
		if (
			currentSentinelIdentity.realPath !== protectedSiblingSentinelIdentity.realPath ||
			currentSentinelIdentity.device !== protectedSiblingSentinelIdentity.device ||
			currentSentinelIdentity.inode !== protectedSiblingSentinelIdentity.inode ||
			readFileSync(protectedSiblingSentinelPath, "utf8") !== protectedSiblingSentinelContents
		) {
			throw new Error(
				`Refusing cleanup because protected sibling sentinel changed: ${protectedSiblingSentinelPath}`,
			);
		}
		assertAllRepositoriesInsideFixture();
		rmSync(fixtureRootDirectoryPath, { recursive: true, force: false, maxRetries: 15, retryDelay: 100 });
		if (!existsSync(protectedSiblingSentinelPath))
			throw new Error("Protected sibling sentinel was removed during cleanup");
		unlinkSync(protectedSiblingSentinelPath);
		cleanupCompleted = true;
	}

	const fixture: IsolatedGitTestWorkspaceFixture = {
		fixtureRootDirectoryPath,
		isolatedHomeDirectoryPath,
		ownedIntegrationProjectsDirectoryPath,
		createIsolatedChildProcessEnvironment(environmentVariableOverrides = {}) {
			const environment = { ...isolatedGitEnvironment };
			for (const [name, value] of Object.entries(environmentVariableOverrides)) {
				if (name.toUpperCase().startsWith("GIT_") || ISOLATION_OWNED_ENVIRONMENT_VARIABLE_NAMES.has(name)) {
					throw new Error(`Cannot override isolation-owned environment variable ${name}`);
				}
				if (value === undefined) delete environment[name];
				else environment[name] = value;
			}
			return environment;
		},
		createNonBareRepository(options) {
			assertSimpleDirectoryName(options.repositoryDirectoryName, "repositoryDirectoryName");
			const repositoryPath = join(repositoriesDirectoryPath, options.repositoryDirectoryName);
			mkdirSync(repositoryPath);
			executeGit({
				arguments_: ["init", "--quiet", "--initial-branch", options.initialBranchName ?? "main"],
				workingDirectoryPath: repositoryPath,
			});
			return registerRepository(repositoryPath);
		},
		createNonBareRepositoryAtOwnedPath(options) {
			const repositoryPath = assertExistingPathInsideFixture(options.repositoryPath, "Owned integration repository");
			if (!isPathInsideOrEqualToRoot(repositoryPath, realpathSync(ownedIntegrationProjectsDirectoryPath))) {
				throw new Error(`Owned integration Git repository escaped isolated Git fixture root: ${repositoryPath}`);
			}
			if (existsSync(join(repositoryPath, ".git")))
				throw new Error(`Repository is already initialized: ${repositoryPath}`);
			executeGit({
				arguments_: ["init", "--quiet", "--initial-branch", options.initialBranchName ?? "main"],
				workingDirectoryPath: repositoryPath,
			});
			return registerRepository(repositoryPath);
		},
		createBareRepository(options) {
			assertSimpleDirectoryName(options.repositoryDirectoryName, "repositoryDirectoryName");
			const repositoryPath = join(repositoriesDirectoryPath, options.repositoryDirectoryName);
			mkdirSync(repositoryPath);
			executeGit({ arguments_: ["init", "--bare", "--quiet"], workingDirectoryPath: repositoryPath });
			return registerRepository(repositoryPath);
		},
		cleanup,
	};

	onTestFinished(cleanup);
	return fixture;
}
