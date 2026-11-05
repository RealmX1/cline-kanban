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
	"bulk_parent_fences_avoid_per_pid_helpers",
	"unchanged_unproven_process_budget",
	"unproven_process_changes_after_budget",
	"detached_descendant",
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
		const kernelContainmentRequired = scenario.startsWith("linux_kernel_");
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
				superviseProcessGroup: true,
				preventRedispatch: true,
				deadlineAtEpochMs: 12_000,
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
			startAndCommand: string;
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
		const child = Object.assign(new EventEmitter(), { pid: 201 });
		const signals: number[] = [];
		let cycle = 0;
		let now = 10_000;
		let inheritedNonce = false;
		let dispatchCount = 0;
		let nativeProbeCallCount = 0;
		const fullProcessSnapshotCycles: number[] = [];
		function nativeStat(pid: number): string {
			const entry = processes.get(pid);
			if (!entry) throw Object.assign(new Error("进程已退出"), { code: "ENOENT" });
			const fields = Array.from({ length: 20 }, () => "0");
			fields[0] = "S";
			fields[1] = String(entry.parent);
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
				rename,
				mkdir,
				unlink,
				join,
				Date: { now: () => now },
				spawn: (_command: string, _arguments: string[], options: { env: Record<string, string> }) => {
					dispatchCount++;
					inheritedNonce = options.env.KANBAN_OWNED_COMMAND_EXECUTION_NONCE === "nonce";
					processes.set(201, {
						parent: 900,
						group: 900,
						version: 1201,
						originalParentVersion: 1900,
						hasNonce: inheritedNonce,
						startAndCommand: "Wed Oct 28 12:00:01 2026 root-command",
					});
					return child;
				},
				spawnSync: () => {
					fullProcessSnapshotCycles.push(cycle);
					return {
						status: 0,
						pid: 9999,
						stdout: [...processes]
							.map(([pid, entry]) => `${pid} ${entry.parent} ${entry.startAndCommand}`)
							.join("\n"),
					};
				},
				execFileSync: (command: string, args: string[]) => {
					if (command === "native-probe") {
						nativeProbeCallCount++;
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
												outsideCurrentUser: false,
												hasExecutionOwnershipToken: entry.hasNonce,
											},
										]
									: [];
							},
						);
						if (args[1] === "--snapshot") {
							fullProcessSnapshotCycles.push(cycle);
							return JSON.stringify({ queryProcessPid: 9999, snapshotComplete: true, processes: rows });
						}
						return JSON.stringify(rows);
					}
					if (args[0] === "-axo")
						return [...processes].map(([pid, entry]) => `${pid} ${entry.group} S`).join("\n");
					const entry = processes.get(Number(args[1]));
					if (!entry) throw Object.assign(new Error("进程已退出"), { status: 1 });
					return args.includes("stat=") ? "S" : entry.startAndCommand;
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
					now += Math.max(1000, delayMs ?? 0);
					if (cycle === 1) {
						if (scenario === "darwin_missing_precision_after_dispatch") {
							const reused = processes.get(201);
							if (reused) processes.set(201, { ...reused, preciseIdentityUnavailable: true, hasNonce: false });
						} else processes.delete(201);
						child.emit("exit", 0);
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
					if (cycle > (scenario.includes("budget") ? 12 : 5)) throw new Error("故障注入：退出归属仍未知");
					queueMicrotask(callback);
				},
			},
			{ timeout: 1000 },
		);
		if (
			[
				"unproven_orphan",
				"darwin_missing_precision_after_dispatch",
				"unchanged_unproven_process_budget",
				"unproven_process_changes_after_budget",
			].includes(scenario)
		)
			await expect(evaluation).rejects.toThrow("退出归属仍未知");
		else await evaluation;
		const progress = JSON.parse(await readFile(join(sandbox.path, "supervisor-progress-nonce.json"), "utf8"));
		if (
			["complete", "bulk_parent_fences_avoid_per_pid_helpers", "linux_kernel_unrelated_late_child"].includes(
				scenario,
			)
		) {
			expect(progress.status).toBe("exited");
			expect(progress.returncode).toBe(0);
		}
		if (
			[
				"detached_descendant",
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
		if (scenario.includes("budget")) {
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
