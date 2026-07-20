import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import treeKill from "tree-kill";
import { onTestFinished } from "vitest";

export type OwnedTestChildProcess = ChildProcess & { pid: number };

export interface OwnedProcessLifecycleTestFixture {
	ownershipToken: string;
	createSanitizedChildProcessEnvironment(environmentVariableOverrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	spawnOwnedProcess(options: {
		command: string;
		arguments?: readonly string[];
		workingDirectoryPath?: string;
		environmentVariables?: NodeJS.ProcessEnv;
		stdio?: StdioOptions;
	}): OwnedTestChildProcess;
	spawnUnrelatedSentinelProcess(): OwnedTestChildProcess;
	readFirstStandardOutputLineAsProcessId(process: OwnedTestChildProcess): Promise<number>;
	terminateOwnedProcessTree(process: OwnedTestChildProcess): Promise<void>;
	isProcessAlive(processId: number | undefined): boolean;
	assertUnrelatedSentinelProcessesAlive(): void;
	cleanup(): Promise<void>;
}

const PROCESS_OWNERSHIP_TOKEN_ENVIRONMENT_VARIABLE_NAME = "CLINE_KANBAN_TEST_PROCESS_OWNERSHIP_TOKEN";
const GRACEFUL_PROCESS_TREE_TERMINATION_TIMEOUT_MILLISECONDS = 2_000;
const FORCED_PROCESS_TREE_TERMINATION_TIMEOUT_MILLISECONDS = 2_000;

function createSanitizedParentProcessEnvironment(
	environmentVariableOverrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const sanitizedEnvironmentVariables: NodeJS.ProcessEnv = {};
	for (const [environmentVariableName, environmentVariableValue] of Object.entries(process.env)) {
		if (!environmentVariableName.toUpperCase().startsWith("GIT_")) {
			sanitizedEnvironmentVariables[environmentVariableName] = environmentVariableValue;
		}
	}
	for (const [environmentVariableName, environmentVariableValue] of Object.entries(environmentVariableOverrides)) {
		if (environmentVariableName.toUpperCase().startsWith("GIT_")) {
			throw new Error(
				`Cannot add Git environment variable ${environmentVariableName} through the generic process fixture sanitizer`,
			);
		}
		if (environmentVariableValue === undefined) {
			delete sanitizedEnvironmentVariables[environmentVariableName];
		} else {
			sanitizedEnvironmentVariables[environmentVariableName] = environmentVariableValue;
		}
	}
	return sanitizedEnvironmentVariables;
}

function isProcessAlive(processId: number | undefined): boolean {
	if (processId === undefined) {
		return false;
	}
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function killProcessTree(processId: number, signal: NodeJS.Signals): Promise<void> {
	return new Promise((resolve, reject) => {
		treeKill(processId, signal, (error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ESRCH") {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function isDetachedProcessGroupAlive(processGroupId: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch {
		return false;
	}
}

function isTrackedProcessTreeAlive(childProcess: OwnedTestChildProcess): boolean {
	return isProcessAlive(childProcess.pid) || isDetachedProcessGroupAlive(childProcess.pid);
}

async function signalTrackedProcessTree(childProcess: OwnedTestChildProcess, signal: NodeJS.Signals): Promise<void> {
	if (isDetachedProcessGroupAlive(childProcess.pid)) {
		try {
			process.kill(-childProcess.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		return;
	}
	if (isProcessAlive(childProcess.pid)) {
		await killProcessTree(childProcess.pid, signal);
	}
}

async function waitForProcessTreeToStop(
	childProcess: OwnedTestChildProcess,
	timeoutMilliseconds: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		if (!isTrackedProcessTreeAlive(childProcess)) {
			return true;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	return !isTrackedProcessTreeAlive(childProcess);
}

function assertSpawnedChildProcessHasProcessId(childProcess: ChildProcess): OwnedTestChildProcess {
	if (childProcess.pid === undefined) {
		throw new Error("Owned process lifecycle fixture spawned a process without a PID");
	}
	return childProcess as OwnedTestChildProcess;
}

export function createOwnedProcessLifecycleTestFixture(): OwnedProcessLifecycleTestFixture {
	const ownershipToken = randomUUID();
	const ownedProcesses = new Set<OwnedTestChildProcess>();
	const unrelatedSentinelProcesses = new Set<OwnedTestChildProcess>();
	const trackedProcessOwnershipTokens = new Map<OwnedTestChildProcess, string>();
	let cleanupPromise: Promise<void> | null = null;

	function spawnTrackedProcess(options: {
		command: string;
		arguments?: readonly string[];
		workingDirectoryPath?: string;
		environmentVariables?: NodeJS.ProcessEnv;
		stdio?: StdioOptions;
		processOwnershipToken: string;
	}): OwnedTestChildProcess {
		if (options.environmentVariables?.[PROCESS_OWNERSHIP_TOKEN_ENVIRONMENT_VARIABLE_NAME] !== undefined) {
			throw new Error(
				`Cannot override fixture-owned environment variable ${PROCESS_OWNERSHIP_TOKEN_ENVIRONMENT_VARIABLE_NAME}`,
			);
		}
		const childProcess = assertSpawnedChildProcessHasProcessId(
			spawn(options.command, [...(options.arguments ?? [])], {
				cwd: options.workingDirectoryPath,
				detached: process.platform !== "win32",
				env: {
					...(options.environmentVariables ?? createSanitizedParentProcessEnvironment()),
					[PROCESS_OWNERSHIP_TOKEN_ENVIRONMENT_VARIABLE_NAME]: options.processOwnershipToken,
				},
				stdio: options.stdio ?? "ignore",
				windowsHide: true,
			}),
		);
		trackedProcessOwnershipTokens.set(childProcess, options.processOwnershipToken);
		return childProcess;
	}

	async function terminateTrackedProcessTree(
		childProcess: OwnedTestChildProcess,
		expectedProcessOwnershipToken: string,
	): Promise<void> {
		if (trackedProcessOwnershipTokens.get(childProcess) !== expectedProcessOwnershipToken) {
			throw new Error(
				`Refusing to terminate a process whose ownership token does not match: pid=${childProcess.pid}`,
			);
		}
		const processId = childProcess.pid;
		if (!isTrackedProcessTreeAlive(childProcess)) {
			return;
		}
		await signalTrackedProcessTree(childProcess, "SIGTERM");
		if (await waitForProcessTreeToStop(childProcess, GRACEFUL_PROCESS_TREE_TERMINATION_TIMEOUT_MILLISECONDS)) {
			return;
		}
		await signalTrackedProcessTree(childProcess, "SIGKILL");
		if (!(await waitForProcessTreeToStop(childProcess, FORCED_PROCESS_TREE_TERMINATION_TIMEOUT_MILLISECONDS))) {
			throw new Error(`Owned process tree remained alive after SIGKILL: pid=${processId}`);
		}
	}

	function assertUnrelatedSentinelProcessesAlive(): void {
		for (const unrelatedSentinelProcess of unrelatedSentinelProcesses) {
			if (!isProcessAlive(unrelatedSentinelProcess.pid)) {
				throw new Error(
					`Unrelated sentinel process was terminated unexpectedly: pid=${unrelatedSentinelProcess.pid}`,
				);
			}
		}
	}

	async function cleanup(): Promise<void> {
		if (cleanupPromise) {
			return cleanupPromise;
		}
		cleanupPromise = (async () => {
			for (const ownedProcess of ownedProcesses) {
				await terminateTrackedProcessTree(ownedProcess, ownershipToken);
			}
			assertUnrelatedSentinelProcessesAlive();
			for (const unrelatedSentinelProcess of unrelatedSentinelProcesses) {
				const sentinelOwnershipToken = trackedProcessOwnershipTokens.get(unrelatedSentinelProcess);
				if (!sentinelOwnershipToken) {
					throw new Error(
						`Unrelated sentinel process lost its ownership token: pid=${unrelatedSentinelProcess.pid}`,
					);
				}
				await terminateTrackedProcessTree(unrelatedSentinelProcess, sentinelOwnershipToken);
			}
			for (const trackedProcess of [...ownedProcesses, ...unrelatedSentinelProcesses]) {
				if (isTrackedProcessTreeAlive(trackedProcess)) {
					throw new Error(`Owned process lifecycle fixture left an orphan process: pid=${trackedProcess.pid}`);
				}
			}
		})();
		return cleanupPromise;
	}

	const fixture: OwnedProcessLifecycleTestFixture = {
		ownershipToken,
		createSanitizedChildProcessEnvironment: createSanitizedParentProcessEnvironment,
		spawnOwnedProcess(options) {
			const childProcess = spawnTrackedProcess({ ...options, processOwnershipToken: ownershipToken });
			ownedProcesses.add(childProcess);
			return childProcess;
		},
		spawnUnrelatedSentinelProcess() {
			const childProcess = spawnTrackedProcess({
				command: process.execPath,
				arguments: ["-e", "setInterval(() => {}, 1000)"],
				stdio: "ignore",
				processOwnershipToken: `unrelated-sentinel-${randomUUID()}`,
			});
			unrelatedSentinelProcesses.add(childProcess);
			return childProcess;
		},
		readFirstStandardOutputLineAsProcessId(childProcess) {
			if (!childProcess.stdout) {
				return Promise.reject(new Error("Owned process stdout is not piped"));
			}
			return new Promise<number>((resolve, reject) => {
				let bufferedOutput = "";
				const timeout = setTimeout(() => {
					reject(new Error(`Timed out waiting for owned process stdout: pid=${childProcess.pid}`));
				}, 5_000);
				childProcess.stdout?.setEncoding("utf8");
				childProcess.stdout?.on("data", (chunk: string) => {
					bufferedOutput += chunk;
					const newlineIndex = bufferedOutput.indexOf("\n");
					if (newlineIndex < 0) {
						return;
					}
					clearTimeout(timeout);
					const processId = Number(bufferedOutput.slice(0, newlineIndex).trim());
					if (!Number.isInteger(processId) || processId <= 0) {
						reject(
							new Error(`Owned process emitted an invalid child PID: ${bufferedOutput.slice(0, newlineIndex)}`),
						);
						return;
					}
					resolve(processId);
				});
			});
		},
		async terminateOwnedProcessTree(childProcess) {
			if (!ownedProcesses.has(childProcess)) {
				throw new Error(`Refusing to terminate a process not owned by this fixture: pid=${childProcess.pid}`);
			}
			await terminateTrackedProcessTree(childProcess, ownershipToken);
			assertUnrelatedSentinelProcessesAlive();
		},
		isProcessAlive,
		assertUnrelatedSentinelProcessesAlive,
		cleanup,
	};

	onTestFinished(cleanup);
	return fixture;
}
