import { type ChildProcess, spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import type { DiagnosticEventJournalChannel } from "../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTaskAttributedProcessTreeResourceSampler } from "../../src/diagnostics/task-attributed-process-tree-resource-sampler";
import { isProcessAlive } from "../../src/server/agent-session-descendant-process-inspection";
import type { TaskResourceUsageAttributionRootEnumeration } from "../../src/server/task-resource-usage-attribution-root-enumeration";

// 用真实的 ps / lsof 验证整条链：一个「harness 根进程」拉起一个 detached（= setsid，与 Claude 的 Bash 工具
// 外壳同形）的 `sh -c` 子进程；根进程退出后子进程被 launchd 收养，采样器仍须把它记在原 task 上并标为残留。
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const spawnedProcessIds: number[] = [];

function killIfAlive(processId: number): void {
	try {
		process.kill(processId, "SIGKILL");
	} catch {
		// 已退出。
	}
}

function killProcessGroupIfAlive(processGroupLeaderId: number): void {
	try {
		process.kill(-processGroupLeaderId, "SIGKILL");
	} catch {
		// 已退出。
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

function spawnHarnessLikeRootWithDetachedShellCommand(): {
	root: ChildProcess;
	detachedShellCommandProcessId: Promise<number>;
} {
	// 根进程：拉起一个 detached 的 `sh -c 'sleep 60'`，把它的 pid 写到 stdout，然后常驻。
	const root = spawn(
		process.execPath,
		[
			"-e",
			[
				"const { spawn } = require('node:child_process');",
				"const child = spawn('sh', ['-c', 'sleep 60; echo done'], { detached: true, stdio: 'ignore' });",
				"child.unref();",
				"process.stdout.write(String(child.pid) + '\\n');",
				"setInterval(() => {}, 1000);",
			].join(" "),
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const detachedShellCommandProcessId = new Promise<number>((resolvePid) => {
		root.stdout?.once("data", (chunk: Buffer) => {
			resolvePid(Number.parseInt(chunk.toString("utf8").trim(), 10));
		});
	});
	return { root, detachedShellCommandProcessId };
}

describeOnPosix("task attributed process tree resource sampler against real processes", () => {
	afterEach(() => {
		for (const processId of spawnedProcessIds.splice(0)) {
			killProcessGroupIfAlive(processId);
			killIfAlive(processId);
		}
	});

	it("keeps billing a setsid'd command to its task after the harness root exits, then closes its lifetime when it ends", async () => {
		const { root, detachedShellCommandProcessId } = spawnHarnessLikeRootWithDetachedShellCommand();
		const rootProcessId = root.pid;
		if (rootProcessId === undefined) {
			throw new Error("root process failed to spawn");
		}
		spawnedProcessIds.push(rootProcessId);
		const shellCommandProcessId = await detachedShellCommandProcessId;
		spawnedProcessIds.push(shellCommandProcessId);

		let rootIsRegistered = true;
		const rootSessionStartedAtEpochMs = Date.now();
		const enumerateAttributionRoots = (): TaskResourceUsageAttributionRootEnumeration => ({
			roots: rootIsRegistered
				? [
						{
							workspaceId: "repo",
							workspacePath: "/tmp/repo",
							sessionTaskId: "it001",
							attributedTaskCardId: "it001",
							sessionCategory: "task_card_main_agent_session",
							sessionTransport: "pty_terminal",
							agentId: "claude",
							rootProcessId,
							rootProcessRole: "agent_harness_root",
							runtimeSessionIncarnationId: "inc-it",
							rootSessionStartedAtEpochMs,
						},
					]
				: [],
			taskWorkingDirectoryAttributions: [],
			workspaceIdByWorkspacePath: new Map(),
		});
		const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
		const sampler = createTaskAttributedProcessTreeResourceSampler({
			enumerateAttributionRoots,
			appendJournalEvent: (channel, payload) => {
				journalEvents.push({ channel, payload });
			},
		});

		await sampler.runSampleTick();
		const liveBeforeRootExit = sampler
			.getLatestLiveTaskResourceUsageSnapshots()
			.find((snapshot) => snapshot.attributedTaskCardId === "it001");
		// 命令分支 = `sh -c` 外壳 + 它 fork 出的 `sleep`，两者都记在这条命令上。
		expect(liveBeforeRootExit?.processCountByProcessClassification).toEqual({
			agent_harness_root_process: 1,
			agent_shell_tool_command_process: 2,
		});
		expect(liveBeforeRootExit?.residentSetSizeKibibytesSumUpperBound).toBeGreaterThan(0);

		// harness 根进程退出，会话 summary 的 pid 随之清空；detached 子进程被 launchd 收养。
		root.kill("SIGKILL");
		rootIsRegistered = false;
		await waitUntil(() => !isProcessAlive(rootProcessId));
		await sampler.runSampleTick();
		const liveAfterRootExit = sampler
			.getLatestLiveTaskResourceUsageSnapshots()
			.find((snapshot) => snapshot.attributedTaskCardId === "it001");
		expect(liveAfterRootExit).toMatchObject({ survivedSessionRootExitProcessCount: 2, attributedProcessCount: 2 });

		// 残留命令结束（detached ⇒ 外壳自成进程组，整组结束）：写出生命周期 episode，带「活过了会话根」
		// 标记与 shell 外壳里的命令文本。
		killProcessGroupIfAlive(shellCommandProcessId);
		await waitUntil(() => !isProcessAlive(shellCommandProcessId));
		await sampler.runSampleTick();
		sampler.stop();

		const shellCommandEpisode = journalEvents.find(
			(event) =>
				event.channel === "task-attributed-process-lifetime-episode" &&
				event.payload.processId === shellCommandProcessId,
		);
		expect(shellCommandEpisode?.payload).toMatchObject({
			attributedTaskCardId: "it001",
			processClassification: "agent_shell_tool_command_process",
			commandLineTextForJournal: "sleep 60; echo done",
			survivedAttributionRootProcessExit: true,
			processLifetimeEndedBy: "process_exited_between_samples",
		});
	});
});
