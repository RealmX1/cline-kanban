import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createTempDir } from "../../utilities/temp-dir";

it.each([
	"complete",
	"darwin_unrelated_native_precision_unavailable",
	"darwin_expired_native_snapshot_rows",
	"darwin_expired_native_snapshot_rows_nonzero_exit",
	"darwin_current_native_snapshot_precision_unavailable",
	"darwin_malformed_process_group_snapshot",
	"darwin_incomplete_process_group_snapshot",
	"legacy_zombie_descendant",
	"native_snapshot_failure_budget_recovers",
	"process_group_snapshot_failure_budget_recovers",
	"process_group_snapshot_failure_budget_recovers_after_timeout",
	"darwin_spawn_failure_without_pid",
	"linux_spawn_failure_without_pid",
	"darwin_spawn_failure_without_pid_precision_budget_recovers",
	...[0, 100, 1582, 10_000].flatMap((count) => [
		`native_retired_owned_${count}`,
		`legacy_retired_owned_${count}`,
		`linux_retired_owned_${count}`,
	]),
	"bulk_parent_fences_avoid_per_pid_helpers",
	"unchanged_unproven_process_budget",
	"unproven_process_changes_after_budget",
	"detached_descendant",
	"darwin_descendant_appears_after_native_process_snapshot",
	"darwin_unrelated_process_appears_after_native_process_snapshot",
	"unproven_orphan",
	"darwin_missing_precision_after_dispatch",
	"darwin_missing_precision_before_dispatch",
	"linux_nonce_detached_descendant",
	"linux_kernel_unrelated_late_child",
	"linux_kernel_detached_without_environment",
	"linux_kernel_capability_unavailable",
])("真实监督入口按原生归属证据处理 %s", async (scenario) => {
	const sandbox = createTempDir("native-owned-supervisor-proof-");
	try {
		const sourceFile = await readFile(
			join(process.cwd(), "src/task-command-execution/task-command-execution-supervisor.ts"),
			"utf8",
		);
		const source = sourceFile.split("const supervisorSource = String.raw`")[1]?.split("`;\n")[0];
		if (!source) throw new Error("未找到监督入口");
		const linux = scenario.startsWith("linux_");
		const retiredOwnedCount = scenario.includes("retired_owned") ? Number(scenario.split("_").at(-1)) : null;
		const legacy = scenario.startsWith("legacy_");
		const kernelContainmentRequired = scenario.startsWith("linux_kernel_");
		const processGroupSnapshotFailure = scenario.startsWith("process_group_snapshot_failure");
		const spawnFailureWithoutPid = scenario.includes("spawn_failure_without_pid");
		const materialsFile = join(sandbox.path, "materials.json");
		await writeFile(
			materialsFile,
			JSON.stringify({
				directory: sandbox.path,
				launchNonce: "nonce",
				executionId: "execution",
				revocationFile: join(sandbox.path, "revoked.json"),
				command: ["isolated-command"],
				workingDirectory: sandbox.path,
				superviseProcessGroup: !legacy,
				preventRedispatch: true,
				deadlineAtEpochMs: scenario.endsWith("after_timeout")
					? 12_000
					: retiredOwnedCount !== null ||
							scenario.includes("snapshot_failure") ||
							scenario.includes("precision_budget")
						? 120_000
						: 12_000,
				darwinOriginalParentGenerationProbePath: linux ? null : "native-probe",
				linuxKernelChildSubreaperContainmentRequired: kernelContainmentRequired,
				linuxKernelChildSubreaperContainmentAddonPath: "native-containment-addon",
			}),
		);
		type SimulatedProcess = {
			parent: number;
			group: number;
			version: number;
			originalParentVersion: number;
			hasNonce: boolean;
			preciseIdentityUnavailable?: boolean;
			outsideCurrentUser?: boolean;
			startAndCommand: string;
			zombie?: boolean;
		};
		const processes = new Map<number, SimulatedProcess>([
			[
				900,
				{
					parent: 1,
					group: 900,
					version: 1900,
					originalParentVersion: 1,
					hasNonce: false,
					startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor",
				},
			],
		]);
		processes.set(1, {
			parent: 0,
			group: 1,
			version: 1,
			originalParentVersion: 0,
			hasNonce: false,
			startAndCommand: "Wed Oct 28 11:00:00 2026 init",
		});
		if (scenario === "darwin_missing_precision_before_dispatch") {
			const owner = processes.get(900);
			if (owner) owner.preciseIdentityUnavailable = true;
		}
		if (scenario === "darwin_unrelated_native_precision_unavailable")
			processes.set(401, {
				parent: 1,
				group: 401,
				version: 1401,
				originalParentVersion: 1,
				hasNonce: false,
				preciseIdentityUnavailable: true,
				outsideCurrentUser: true,
				startAndCommand: "Wed Oct 28 11:00:00 2026 unrelated-protected-process",
			});
		if (scenario === "bulk_parent_fences_avoid_per_pid_helpers")
			for (let pid = 4000; pid < 4300; pid++)
				processes.set(pid, {
					parent: 1,
					group: pid,
					version: pid + 1000,
					originalParentVersion: 1,
					hasNonce: false,
					startAndCommand: "Wed Oct 28 11:00:00 2026 unrelated-baseline-process",
				});
		const child = Object.assign(new EventEmitter(), { pid: spawnFailureWithoutPid ? undefined : 201 });
		const signals: number[] = [];
		let cycle = 0;
		let now = 10_000;
		let inheritedNonce = false;
		let dispatchCount = 0;
		let nativeProbeCallCount = 0;
		let processGroupSnapshotQueryCount = 0;
		const regularQueryCountsByCycle = new Map<number, { ps: number; native: number }>();
		let unchangedProgressWriteCount = 0;
		const fullProcessSnapshotCycles: number[] = [];
		function nativeStat(pid: number): string {
			const entry = processes.get(pid);
			if (!entry) throw Object.assign(new Error("进程已退出"), { code: "ENOENT" });
			const fields = Array.from({ length: 20 }, () => "0");
			fields[0] = "S";
			fields[1] = String(entry.parent);
			fields[2] = String(entry.group);
			fields[19] = String(entry.version);
			return `${pid} (simulated-command) ${fields.join(" ")}`;
		}
		const readNativeFile = (path: string) => {
			const match = path.match(/^\/proc\/(\d+)\/(stat|environ)$/);
			if (!match) throw new Error(`未预期原生读取：${path}`);
			const pid = Number(match[1]);
			if (match[2] === "stat") return nativeStat(pid);
			return [
				"FIRST=1",
				...(processes.get(pid)?.hasNonce ? ["KANBAN_OWNED_COMMAND_EXECUTION_NONCE=nonce"] : []),
				"LAST=1",
				"VALUE=KANBAN_OWNED_COMMAND_EXECUTION_NONCE=nonce",
			].join(String.fromCharCode(0));
		};
		function simulatedProcessGroupSnapshot(): string {
			if (
				[
					"darwin_descendant_appears_after_native_process_snapshot",
					"darwin_unrelated_process_appears_after_native_process_snapshot",
				].includes(scenario) &&
				cycle === 1
			)
				processes.set(301, {
					parent: 1,
					group: 301,
					version: 1301,
					originalParentVersion: 99999,
					hasNonce: scenario === "darwin_descendant_appears_after_native_process_snapshot" && inheritedNonce,
					outsideCurrentUser: scenario === "darwin_unrelated_process_appears_after_native_process_snapshot",
					startAndCommand: "Wed Oct 28 12:00:02 2026 descendant-born-after-native-snapshot",
				});
			processGroupSnapshotQueryCount++;
			if (scenario === "darwin_malformed_process_group_snapshot" && cycle >= 1) return "unreadable row";
			if (scenario === "darwin_incomplete_process_group_snapshot" && cycle >= 1) return "1 1 S\n";
			if (processGroupSnapshotFailure && cycle <= 4)
				throw Object.assign(new Error("故障注入：进程组快照暂时不可读"), { status: 1 });
			return [...processes]
				.map(([pid, entry]) => `${pid} ${entry.group} ${entry.zombie ? "Z" : "S"}`)
				.concat("9999 900 S")
				.join("\n");
		}
		const evaluation = runInNewContext(
			`(async()=>{${source.replace(/^import .*;\n/gm, "")} })()`,
			{
				createHash,
				open,
				readFile: (path: string, encoding?: "utf8") =>
					path.startsWith("/proc/") ? Promise.resolve(readNativeFile(path)) : readFile(path, encoding),
				readFileSync: linux ? readNativeFile : readFileSync,
				readlinkSync: () => "pid:[123456]",
				createRequire: () => () => ({
					establish: () => (scenario === "linux_kernel_capability_unavailable" ? -1 : 1),
					observe: () => 1,
					reapAndObserve: () =>
						[...processes].some(([pid, entry]) => pid !== 900 && entry.parent === 900) ? 1 : 0,
				}),
				rename: async (from: string, to: string) => {
					if (cycle >= 2 && cycle < 8 && to.includes("supervisor-progress-")) unchangedProgressWriteCount++;
					await rename(from, to);
				},
				mkdir,
				unlink,
				join,
				Date: { now: () => now },
				spawn: (_command: string, _arguments: string[], options: { env: Record<string, string> }) => {
					dispatchCount++;
					inheritedNonce = options.env.KANBAN_OWNED_COMMAND_EXECUTION_NONCE === "nonce";
					if (spawnFailureWithoutPid) {
						if (scenario.includes("precision_budget")) {
							const owner = processes.get(900);
							if (owner) owner.preciseIdentityUnavailable = true;
						}
						queueMicrotask(() => child.emit("error", new Error("spawn isolated-command ENOENT")));
						return child;
					}
					processes.set(201, {
						parent: 900,
						group: 900,
						version: 1201,
						originalParentVersion: 1900,
						hasNonce: inheritedNonce,
						startAndCommand: "Wed Oct 28 12:00:01 2026 root-command",
					});
					if (scenario === "legacy_zombie_descendant")
						processes.set(301, {
							parent: 201,
							group: 900,
							version: 1301,
							originalParentVersion: 1201,
							hasNonce: false,
							zombie: true,
							startAndCommand: "Wed Oct 28 12:00:02 2026 exited-descendant",
						});
					if (retiredOwnedCount !== null)
						for (let index = 0; index < retiredOwnedCount + 3; index++)
							processes.set(10_000 + index, {
								parent: 201,
								group: 900,
								version: 20_000 + index,
								originalParentVersion: 1201,
								hasNonce: inheritedNonce,
								startAndCommand: "Wed Oct 28 12:00:02 2026 owned-history-descendant",
							});
					return child;
				},
				spawnSync: (_command: string, args: string[]) => {
					if (cycle >= 1 && cycle < 8) {
						const counts = regularQueryCountsByCycle.get(cycle) ?? { ps: 0, native: 0 };
						counts.ps++;
						regularQueryCountsByCycle.set(cycle, counts);
					}
					if (args[0] === "-axo" && args[1] === "pid=,pgid=,stat=")
						return { status: 0, pid: 9999, stdout: simulatedProcessGroupSnapshot() };
					fullProcessSnapshotCycles.push(cycle);
					return {
						status: 0,
						pid: 9999,
						stdout: [...processes]
							.map(
								([pid, entry]) => `${pid} ${entry.parent} ${entry.zombie ? "Z" : "S"} ${entry.startAndCommand}`,
							)
							.join("\n"),
					};
				},
				execFileSync: (command: string, args: string[]) => {
					if (cycle >= 1 && cycle < 8) {
						const counts = regularQueryCountsByCycle.get(cycle) ?? { ps: 0, native: 0 };
						if (command === "ps") counts.ps++;
						else counts.native++;
						regularQueryCountsByCycle.set(cycle, counts);
					}
					if (command === "native-probe") {
						nativeProbeCallCount++;
						if (
							scenario === "native_snapshot_failure_budget_recovers" &&
							args[1] === "--snapshot" &&
							(cycle === 1 || cycle === 2)
						) {
							if (cycle === 2)
								expect(
									JSON.parse(readFileSync(join(sandbox.path, "supervisor-progress-nonce.json"), "utf8"))
										.nativeOwnershipUnproven,
								).toBe(true);
							throw Object.assign(new Error("故障注入：完整快照暂时不可读"), { code: "EACCES" });
						}
						const rows = (args[1] === "--snapshot" ? [...processes.keys()] : args.slice(1).map(Number)).flatMap(
							(pid) => {
								const entry = processes.get(pid);
								return entry
									? [
											{
												pid,
												processUniqueIdentity: entry.preciseIdentityUnavailable
													? undefined
													: String(entry.version),
												parentProcessPid: entry.parent,
												processIdVersion: entry.version,
												originalParentProcessIdVersion: entry.originalParentVersion,
												outsideCurrentUser: entry.outsideCurrentUser === true,
												processIsZombie: entry.zombie === true,
												hasExecutionOwnershipToken: entry.hasNonce,
											},
										]
									: [];
							},
						);
						if (args[1] === "--snapshot") {
							if (scenario.startsWith("darwin_expired_native_snapshot_rows") && cycle >= 1)
								rows.push({
									pid: 4000 + cycle,
									processUniqueIdentity: undefined,
									parentProcessPid: -1,
									processIdVersion: 0,
									originalParentProcessIdVersion: 0,
									outsideCurrentUser: false,
									processIsZombie: false,
									hasExecutionOwnershipToken: false,
								});
							fullProcessSnapshotCycles.push(cycle);
							return JSON.stringify({
								queryProcessPid: 9999,
								snapshotComplete: rows.every((row) => row.processUniqueIdentity !== undefined),
								processes: rows,
							});
						}
						return JSON.stringify(rows);
					}
					if (args[0] === "-axo" && args[1] === "pid=,pgid=,stat=") {
						return simulatedProcessGroupSnapshot();
					}
					if (args[0] === "-axo")
						return [...processes]
							.map(([pid, entry]) =>
								args[1] === "pid=,ppid=,stat=,lstart="
									? `${pid} ${entry.parent} ${entry.zombie ? "Z" : "S"} ${entry.startAndCommand}`
									: `${pid} ${entry.group} ${entry.zombie ? "Z" : "S"}`,
							)
							.join("\n");
					const entry = processes.get(Number(args[1]));
					if (!entry) throw Object.assign(new Error("进程已退出"), { status: 1 });
					return args.includes("stat=") ? (entry.zombie ? "Z" : "S") : entry.startAndCommand;
				},
				process: {
					pid: 900,
					platform: linux ? "linux" : "darwin",
					argv: ["node", "supervisor.mjs", materialsFile],
					env: {},
					on: () => undefined,
					kill: (pid: number) => {
						signals.push(pid);
						processes.delete(pid);
						if (pid === 201) child.emit("exit", null, "SIGTERM");
					},
				},
				setTimeout: (callback: () => void, delayMs?: number) => {
					cycle++;
					now += Math.max(scenario.includes("budget") ? 15_000 : 1000, delayMs ?? 0);
					if (cycle === 5 && processGroupSnapshotFailure) {
						const budget = JSON.parse(
							readFileSync(join(sandbox.path, "post-script-ownership-recovery-budget-nonce.json"), "utf8"),
						);
						expect(budget.unchangedEvidenceProbeCount).toBe(3);
					}
					if (cycle === 5 && scenario.includes("precision_budget")) {
						const progress = JSON.parse(
							readFileSync(join(sandbox.path, "supervisor-progress-nonce.json"), "utf8"),
						);
						expect(progress.unprovenOwnershipProcesses.length).toBeLessThanOrEqual(2);
						expect(progress.postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount).toBe(3);
						const owner = processes.get(900);
						if (owner) owner.preciseIdentityUnavailable = false;
					}
					if (cycle === 1) {
						if (scenario === "darwin_unrelated_native_precision_unavailable") {
							expect(
								JSON.parse(readFileSync(join(sandbox.path, "supervisor-progress-nonce.json"), "utf8"))
									.nativeOwnershipUnproven,
							).toBe(true);
							processes.delete(401);
						}
						if (scenario === "darwin_missing_precision_after_dispatch") {
							const reused = processes.get(201);
							if (reused) processes.set(201, { ...reused, preciseIdentityUnavailable: true, hasNonce: false });
						} else processes.delete(201);
						if (!spawnFailureWithoutPid) child.emit("exit", scenario.endsWith("nonzero_exit") ? 3 : 0);
						if (scenario === "darwin_current_native_snapshot_precision_unavailable")
							processes.set(401, {
								parent: -1,
								group: 401,
								version: 1401,
								originalParentVersion: 99999,
								hasNonce: false,
								preciseIdentityUnavailable: true,
								startAndCommand: "Wed Oct 28 12:00:02 2026 current-process-without-native-precision",
							});
						if (retiredOwnedCount !== null)
							for (let index = 0; index < retiredOwnedCount; index++) processes.delete(10_000 + index);
						if (
							[
								"detached_descendant",
								"unproven_orphan",
								"unchanged_unproven_process_budget",
								"unproven_process_changes_after_budget",
								"linux_nonce_detached_descendant",
								"linux_kernel_detached_without_environment",
							].includes(scenario)
						)
							processes.set(301, {
								parent: kernelContainmentRequired ? 900 : 1,
								group: 301,
								version: 1301,
								originalParentVersion: 99999,
								hasNonce:
									["detached_descendant", "linux_nonce_detached_descendant"].includes(scenario) &&
									inheritedNonce,
								startAndCommand: "Wed Oct 28 12:00:02 2026 reparented-descendant",
							});
						if (scenario === "linux_kernel_unrelated_late_child")
							processes.set(401, {
								parent: 1,
								group: 401,
								version: 1401,
								originalParentVersion: 1,
								hasNonce: false,
								startAndCommand: "Wed Oct 28 12:00:02 2026 unrelated-runtime-or-verification-child",
							});
					}
					if (cycle === 8 && scenario === "unproven_process_changes_after_budget") {
						const current = processes.get(301);
						if (current) current.version++;
					}
					if (cycle === 8 && retiredOwnedCount !== null)
						for (let index = retiredOwnedCount; index < retiredOwnedCount + 3; index++)
							processes.delete(10_000 + index);
					if (cycle > (scenario.includes("budget") || retiredOwnedCount !== null ? 12 : 5))
						throw new Error("故障注入：退出归属仍未知");
					queueMicrotask(callback);
				},
			},
			{ timeout: 1000 },
		);
		if (
			[
				"unproven_orphan",
				"darwin_missing_precision_after_dispatch",
				"darwin_current_native_snapshot_precision_unavailable",
				"darwin_malformed_process_group_snapshot",
				"darwin_incomplete_process_group_snapshot",
				"unchanged_unproven_process_budget",
				"unproven_process_changes_after_budget",
			].includes(scenario)
		)
			await expect(evaluation).rejects.toThrow("退出归属仍未知");
		else await evaluation;
		const progress = JSON.parse(await readFile(join(sandbox.path, "supervisor-progress-nonce.json"), "utf8"));
		if (scenario === "darwin_unrelated_native_precision_unavailable") {
			expect(progress.status).toBe("exited");
			expect(signals).toEqual([]);
			expect(dispatchCount).toBe(1);
		}
		if (scenario === "legacy_zombie_descendant") {
			expect(progress.status).toBe("exited");
			expect(signals).toEqual([]);
		}
		if (scenario.startsWith("darwin_expired_native_snapshot_rows")) {
			expect(progress.status).toBe("exited");
			expect(progress.returncode).toBe(scenario.endsWith("nonzero_exit") ? 3 : 0);
			expect(progress.nativeOwnershipUnproven).toBe(false);
			expect(cycle).toBe(1);
			expect(dispatchCount).toBe(1);
			expect(signals).toEqual([]);
		}
		if (scenario === "darwin_current_native_snapshot_precision_unavailable") {
			expect(progress.nativeOwnershipUnproven).toBe(true);
			expect(progress.unprovenOwnershipProcesses.map((entry: { pid: number }) => entry.pid)).toContain(401);
			expect(progress.status).not.toBe("exited");
			expect(signals).toEqual([]);
		}
		if (["darwin_malformed_process_group_snapshot", "darwin_incomplete_process_group_snapshot"].includes(scenario)) {
			expect(progress.nativeOwnershipUnproven).toBe(true);
			expect(progress.nativeQueryFailureObservations[0].query).toBe("process_group_snapshot");
			expect(progress.status).not.toBe("exited");
			expect(dispatchCount).toBe(1);
			expect(signals).toEqual([]);
		}
		if (spawnFailureWithoutPid) {
			expect(progress.status).toBe("exited");
			expect(progress.error).toContain("ENOENT");
			expect(progress.nativeOwnershipUnproven).toBe(false);
			expect(progress.ownedProcesses).toEqual([]);
			expect(dispatchCount).toBe(1);
			expect(signals).toEqual([]);
			if (scenario.includes("precision_budget")) expect(cycle).toBeGreaterThanOrEqual(5);
		}
		if (scenario.includes("snapshot_failure")) {
			expect(progress.status).toBe(scenario.endsWith("after_timeout") ? "cancelled" : "exited");
			expect(progress.nativeOwnershipUnproven).toBe(false);
			expect(signals).toEqual([]);
			expect(dispatchCount).toBe(1);
		}
		if (processGroupSnapshotFailure) expect(processGroupSnapshotQueryCount).toBeGreaterThan(4);
		if (retiredOwnedCount !== null) {
			expect(progress.status).toBe("exited");
			expect(progress.ownedProcesses).toHaveLength(retiredOwnedCount + 4);
			expect(signals).toEqual([]);
			expect(unchangedProgressWriteCount).toBe(0);
			expect(regularQueryCountsByCycle.size).toBe(7);
			for (const counts of regularQueryCountsByCycle.values()) {
				expect(counts.ps).toBeLessThanOrEqual(2);
				expect(counts.native).toBeLessThanOrEqual(4);
			}
		}
		if (
			[
				"complete",
				"bulk_parent_fences_avoid_per_pid_helpers",
				"linux_kernel_unrelated_late_child",
				"darwin_unrelated_process_appears_after_native_process_snapshot",
			].includes(scenario)
		) {
			expect(progress.status).toBe("exited");
			expect(progress.returncode).toBe(0);
		}
		if (
			[
				"detached_descendant",
				"darwin_descendant_appears_after_native_process_snapshot",
				"linux_nonce_detached_descendant",
				"linux_kernel_detached_without_environment",
			].includes(scenario)
		) {
			expect(signals).toContain(301);
			expect(progress.status).toBe("cancelled");
			expect(progress.timedOut).toBe(true);
		}
		if (scenario === "unproven_orphan") {
			expect(progress.nativeOwnershipUnproven).toBe(true);
			expect(progress.status).not.toBe("exited");
			expect(signals).not.toContain(301);
		}
		if (scenario === "darwin_missing_precision_after_dispatch") {
			expect(progress.nativeOwnershipUnproven).toBe(true);
			expect(progress.status).not.toBe("exited");
			expect(signals).not.toContain(201);
		}
		if (scenario === "linux_kernel_unrelated_late_child") {
			expect(processes.has(401)).toBe(true);
			expect(signals).not.toContain(401);
		}
		if (scenario === "darwin_missing_precision_before_dispatch") {
			expect(dispatchCount).toBe(0);
			expect(signals).toEqual([]);
			expect(progress.status).toBe("cancelled");
			expect(progress.timedOut).toBe(true);
		}

		if (scenario === "bulk_parent_fences_avoid_per_pid_helpers") expect(nativeProbeCallCount).toBeLessThan(30);
		if (scenario === "unchanged_unproven_process_budget" || scenario === "unproven_process_changes_after_budget") {
			const budget = JSON.parse(
				await readFile(join(sandbox.path, "post-script-ownership-recovery-budget-nonce.json"), "utf8"),
			);
			expect(budget.unchangedEvidenceProbeCount).toBe(3);
			expect(budget.nextActiveProbeAtEpochMs).toBeGreaterThan(0);
			if (scenario === "unchanged_unproven_process_budget")
				expect(fullProcessSnapshotCycles.every((cycle) => cycle < 8)).toBe(true);
			else expect(fullProcessSnapshotCycles.some((cycle) => cycle >= 8)).toBe(true);
			expect(signals).not.toContain(301);
			expect(progress.status).not.toBe("exited");
		}

		if (scenario === "linux_kernel_capability_unavailable") {
			expect(dispatchCount).toBe(0);
			expect(progress.status).toBe("cancelled");
			expect(progress.error).toContain("PR_SET_CHILD_SUBREAPER");
		}
	} finally {
		sandbox.cleanup();
	}
});
