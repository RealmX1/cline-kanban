// runtime-integration 测试派生子进程的生命周期收口：启动等待失败即 SIGKILL，afterEach 兜底回收。
// 背景：启动 helper 超时后只 reject 不 kill，晚到 banner 的 runtime 会变成 ppid=1 的长寿孤儿（00ea7 F3）。
import type { ChildProcess } from "node:child_process";

import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveTwoTierDeadlineJudgement,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

// EXPERIMENT_NODE: 启动等待一次性放宽到 30s vs 超时后 SIGKILL 并重试一次
// 实测冷启动：正常 QoS 1.2–2.6s，后台 QoS 4.7–6.8s；重试会丢掉已完成一半的启动、在压力峰值再冷启动一次。
export const RUNTIME_SERVER_STARTUP_BANNER_WAIT_TIMEOUT_MS = 30_000;

export interface CliChildProcessSpawnsWithinIntegrationTestBudget {
	cliChildProcessSpawnCount: number;
	cliChildProcessExitTwoTierDeadline: LoadSensitiveWallClockTwoTierDeadline;
}

// 用例超时 = 每次冷启动 runtime 的启动等待上限 + 用例本体预算；用例超时容不下启动等待时，放宽启动等待就没有意义。
// 有多次 CLI spawn 时按累计预算加：每次按软档的 2 倍计，外加一个硬档（让第一个真正挂死的 spawn 能以
// 带诊断的两档失败收场，而不是被用例超时截断）。不按「次数 × 硬档」：12 次 create 的用例会膨胀到 10 分钟。
// EXPERIMENT_NODE: 每次 CLI spawn 计「软档 × 2」vs 更大倍数；负载下多个 spawn 同时接近硬档时用例超时会先触发
export function computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts(input: {
	runtimeColdStartCount: number;
	testBodyTimeoutBudgetMs: number;
	cliChildProcessSpawns?: CliChildProcessSpawnsWithinIntegrationTestBudget;
}): number {
	const cliChildProcessSpawnBudgetMs = input.cliChildProcessSpawns
		? input.cliChildProcessSpawns.cliChildProcessSpawnCount *
				input.cliChildProcessSpawns.cliChildProcessExitTwoTierDeadline.softDeadlineMsExpectedOnUncontendedHost *
				2 +
			input.cliChildProcessSpawns.cliChildProcessExitTwoTierDeadline
				.hardDeadlineMsOnlyExplainedByRealHangOrRegression
		: 0;
	return (
		input.runtimeColdStartCount * RUNTIME_SERVER_STARTUP_BANNER_WAIT_TIMEOUT_MS +
		cliChildProcessSpawnBudgetMs +
		input.testBodyTimeoutBudgetMs
	);
}

const SIGKILLED_CHILD_PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS = 5_000;

const RUNTIME_SERVER_STARTUP_BANNER_PATTERN = /Cline Kanban running at (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)/;

// 被信号结束的子进程 exitCode 为 null、signalCode 有值；runtime 优雅关停后会 reraise SIGINT，只看 exitCode 会白等到超时。
export function hasChildProcessExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForChildProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasChildProcessExited(child)) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			child.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		child.once("exit", handleExit);
	});
}

// 两档等待子进程退出：超过软档只写 annotation；超过硬档时先 SIGKILL 并确认退出，再抛错（不留孤儿）。
export async function waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	child: ChildProcess,
	deadline: LoadSensitiveWallClockTwoTierDeadline,
	options: { describeChildProcessOutputForFailureMessage?: () => string } = {},
): Promise<LoadSensitiveTwoTierDeadlineJudgement> {
	try {
		return await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			testContext,
			deadline,
			() => hasChildProcessExited(child),
			{ describeLastObservedStateForFailureMessage: options.describeChildProcessOutputForFailureMessage },
		);
	} catch (deadlineFailure) {
		const didExitAfterSigkill = await sigkillChildProcessAndWaitForExit(child);
		if (!didExitAfterSigkill && deadlineFailure instanceof Error) {
			deadlineFailure.message += `\nSIGKILL 后 ${SIGKILLED_CHILD_PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS}ms 内仍未确认子进程退出 (pid=${String(child.pid)})。`;
		}
		throw deadlineFailure;
	}
}

export async function sigkillChildProcessAndWaitForExit(
	child: ChildProcess,
	timeoutMs = SIGKILLED_CHILD_PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS,
): Promise<boolean> {
	if (hasChildProcessExited(child)) {
		return true;
	}
	child.kill("SIGKILL");
	return await waitForChildProcessExit(child, timeoutMs);
}

// 失败分支（没有 pipe / 超时 / 启动前退出）一律先摘监听、SIGKILL 并等退出，再 reject；成功分支保留 data 监听以持续排空 pipe。
export async function waitForRuntimeServerStartupBannerOrSigkillChild(
	child: ChildProcess,
	timeoutMs = RUNTIME_SERVER_STARTUP_BANNER_WAIT_TIMEOUT_MS,
): Promise<{ runtimeUrl: string }> {
	const childStdout = child.stdout;
	const childStderr = child.stderr;
	if (!childStdout || !childStderr) {
		await sigkillChildProcessAndWaitForExit(child);
		throw new Error("Expected child process stdout/stderr pipes to be available.");
	}

	return await new Promise((resolveStart, rejectStart) => {
		let settled = false;
		let stdout = "";
		let stderr = "";

		const failStartupAfterSigkillingChild = (startupFailure: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			childStdout.removeListener("data", handleStdoutData);
			childStderr.removeListener("data", handleStderrData);
			child.removeListener("exit", handleExitBeforeStartup);
			void sigkillChildProcessAndWaitForExit(child).then((didExitAfterSigkill) => {
				if (didExitAfterSigkill) {
					rejectStart(startupFailure);
					return;
				}
				rejectStart(
					new Error(
						`${startupFailure.message}\nSIGKILL 后 ${SIGKILLED_CHILD_PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS}ms 内仍未确认子进程退出 (pid=${String(child.pid)})。`,
					),
				);
			});
		};
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (settled) {
				return;
			}
			const runtimeUrl = stdout.match(RUNTIME_SERVER_STARTUP_BANNER_PATTERN)?.[1];
			if (!runtimeUrl) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			child.removeListener("exit", handleExitBeforeStartup);
			resolveStart({ runtimeUrl });
		};
		const handleStdoutData = (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		};
		const handleStderrData = (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		};
		const handleExitBeforeStartup = (code: number | null, signal: NodeJS.Signals | null) => {
			failStartupAfterSigkillingChild(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		};
		const timeoutId = setTimeout(() => {
			failStartupAfterSigkillingChild(
				new Error(
					`Timed out after ${timeoutMs}ms waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		}, timeoutMs);

		childStdout.on("data", handleStdoutData);
		childStderr.on("data", handleStderrData);
		child.once("exit", handleExitBeforeStartup);
	});
}

export interface SpawnedChildProcessRegistrySigkilledAfterEachTest {
	register: (child: ChildProcess) => ChildProcess;
	sigkillEveryStillRunningChildProcessAndWaitForExit: () => Promise<void>;
}

// 只登记本测试文件自己 spawn 的 ChildProcess 句柄；绝不按端口或命令行反查 PID。
export function createSpawnedChildProcessRegistrySigkilledAfterEachTest(): SpawnedChildProcessRegistrySigkilledAfterEachTest {
	const stillRunningSpawnedChildProcesses = new Set<ChildProcess>();
	return {
		register(child) {
			if (hasChildProcessExited(child)) {
				return child;
			}
			stillRunningSpawnedChildProcesses.add(child);
			child.once("exit", () => {
				stillRunningSpawnedChildProcesses.delete(child);
			});
			return child;
		},
		async sigkillEveryStillRunningChildProcessAndWaitForExit() {
			const childProcessesToSigkill = [...stillRunningSpawnedChildProcesses];
			const exitConfirmations = await Promise.all(
				childProcessesToSigkill.map(async (child) => ({
					pid: child.pid,
					didExit: await sigkillChildProcessAndWaitForExit(child),
				})),
			);
			const unconfirmedPids = exitConfirmations
				.filter((confirmation) => !confirmation.didExit)
				.map((confirmation) => String(confirmation.pid));
			if (unconfirmedPids.length > 0) {
				throw new Error(
					`afterEach SIGKILL 后 ${SIGKILLED_CHILD_PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS}ms 内仍未确认退出的子进程: pid=${unconfirmedPids.join(",")}`,
				);
			}
		},
	};
}
