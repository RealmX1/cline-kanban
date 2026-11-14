import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	AgentSessionPtyHostWireFrameDecoder,
	encodeJsonControlMessageFrame,
} from "../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-frame-codec";
import { AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION } from "../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";

export const TEST_PTY_LIFETIME_RECORDS_DIRECTORY_ENVIRONMENT_VARIABLE =
	"CLINE_KANBAN_TEST_PTY_LIFETIME_RECORDS_DIRECTORY";
export const TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE = "CLINE_KANBAN_TEST_PTY_LIFETIME_LEASE_PATH";
const requireFromHere = createRequire(import.meta.url);
const preloadPath = fileURLToPath(new URL("./isolated-test-owned-pty-host-lifetime-preload.cjs", import.meta.url));
const reaperEntryPath = fileURLToPath(new URL("./isolated-test-owned-pty-host-reaper-entry.ts", import.meta.url));
const processGenerationSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1) });
const socketIdentitySchema = z.object({ device: z.number(), inode: z.number() });
const leaseSchema = z.object({
	nonce: z.string().uuid(),
	fixtureRootDirectoryPath: z.string(),
	owner: processGenerationSchema,
	ownerSocketPath: z.string(),
	ownerSocketIdentity: socketIdentitySchema.nullable().default(null),
	closed: z.boolean(),
	synchronousCleanupInProgress: z.boolean(),
});
const hostRecordSchema = z.object({
	leaseNonce: z.string().uuid(),
	process: processGenerationSchema,
	socketPath: z.string(),
	hostBuildIdentity: z.string(),
	hostProcessInstanceId: z.string().nullable(),
	socketIdentity: socketIdentitySchema.nullable(),
	observedProcesses: z.array(processGenerationSchema),
	outcome: z.enum(["pending", "unknown", "completed"]),
	diagnostic: z.string().optional(),
});
const hostStatusSchema = z.object({
	type: z.literal("query_agent_session_pty_host_readonly_status_response"),
	hostProcessId: z.number(),
	hostBuildIdentity: z.string(),
	hostProcessInstanceId: z.string(),
	controllerProcessId: z.number().nullable(),
	hostedSessions: z.array(z.object({ processId: z.number(), exited: z.boolean() })),
});
type TestOwnedProcessGeneration = z.infer<typeof processGenerationSchema>;
type TestPtyLifetimeLease = z.infer<typeof leaseSchema>;
type TestOwnedHostRecord = z.infer<typeof hostRecordSchema>;

function writeJsonAtomically(path: string, value: unknown): void {
	const stagingPath = `${path}.${randomUUID()}.writing`;
	writeFileSync(stagingPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	renameSync(stagingPath, path);
}

function appendReclamationAuditObservation(leasePath: string, observation: Record<string, unknown>): void {
	appendFileSync(
		join(dirname(leasePath), "reclamation-attempts.jsonl"),
		`${JSON.stringify({
			observedAtEpochMs: Date.now(),
			...observation,
		})}\n`,
		{ mode: 0o600 },
	);
}

// ps 失败是缺证，绝不能当作进程已退出；僵尸已不再持有 PTY/端口。
export function readTestOwnedProcessGeneration(pid: number): TestOwnedProcessGeneration | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], {
		env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
		encoding: "utf8",
		timeout: 2_000,
	});
	if (!result.error && result.status === 1 && !result.stdout.trim()) return null;
	if (result.error || result.status !== 0)
		throw new Error(`无法核验进程世代 ${pid}: ${result.error?.message ?? result.stderr}`);
	const match = result.stdout.trim().match(/^(\S+)\s+(.+)$/);
	if (!match?.[1] || !match[2]) throw new Error(`进程世代不可解析: ${pid}`);
	return /^[ZX]/.test(match[1]) ? null : { pid, startedAt: match[2] };
}

function processGenerationStillExists(expected: TestOwnedProcessGeneration): boolean {
	return readTestOwnedProcessGeneration(expected.pid)?.startedAt === expected.startedAt;
}

function readSocketIdentity(socketPath: string): z.infer<typeof socketIdentitySchema> | null {
	try {
		const stat = lstatSync(socketPath);
		if (!stat.isSocket()) throw new Error(`测试 PTY 路径已被替换为非 socket: ${socketPath}`);
		return { device: stat.dev, inode: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function sameSocketIdentity(
	a: TestOwnedHostRecord["socketIdentity"],
	b: TestOwnedHostRecord["socketIdentity"],
): boolean {
	return a !== null && b !== null && a.device === b.device && a.inode === b.inode;
}

export function resolveTestPtyLifetimeRecordsDirectory(): string {
	return (
		process.env[TEST_PTY_LIFETIME_RECORDS_DIRECTORY_ENVIRONMENT_VARIABLE] ??
		join(homedir(), ".cline", "kanban", "isolated-test-pty-lifetime-records")
	);
}

function reaperLaunchArguments(leasePath: string): string[] {
	return ["--import", requireFromHere.resolve("tsx"), reaperEntryPath, leasePath];
}

function reaperEnvironment(): NodeJS.ProcessEnv {
	return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
}

export function createIsolatedTestOwnedPtyHostLifetime(fixtureRootDirectoryPath: string): {
	environmentVariables: NodeJS.ProcessEnv;
	closeAndVerifyOwnedHostExit(): void;
} {
	if (process.platform === "win32") return { environmentVariables: {}, closeAndVerifyOwnedHostExit() {} };
	const recordsDirectory = resolveTestPtyLifetimeRecordsDirectory();
	mkdirSync(recordsDirectory, { recursive: true, mode: 0o700 });
	const lifetimeDirectory = mkdtempSync(join(recordsDirectory, "fixture-lifetime-"));
	const leasePath = join(lifetimeDirectory, "fixture-owner-lease.json");
	const owner = readTestOwnedProcessGeneration(process.pid);
	if (!owner) throw new Error("测试 fixture owner 的进程世代不可得");
	const nonce = randomUUID();
	const lease: TestPtyLifetimeLease = {
		nonce,
		fixtureRootDirectoryPath,
		owner,
		ownerSocketPath: `/tmp/kpt-owner-${nonce.slice(0, 16)}.sock`,
		ownerSocketIdentity: null,
		closed: false,
		synchronousCleanupInProgress: false,
	};
	writeJsonAtomically(leasePath, lease);
	const connections = new Set<Socket>();
	const ownerServer = createServer((socket) => {
		connections.add(socket);
		socket.unref();
		socket.once("data", (bytes) => {
			if (bytes.toString() === nonce) socket.write(nonce);
			else socket.destroy();
		});
		socket.once("close", () => connections.delete(socket));
		socket.on("error", () => socket.destroy());
	});
	ownerServer.listen(lease.ownerSocketPath);
	ownerServer.unref();
	lease.ownerSocketIdentity = readSocketIdentity(lease.ownerSocketPath);
	writeJsonAtomically(leasePath, lease);
	let completed = false;
	return {
		environmentVariables: { [TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE]: leasePath },
		closeAndVerifyOwnedHostExit() {
			if (completed) return;
			lease.closed = true;
			lease.synchronousCleanupInProgress = true;
			writeJsonAtomically(leasePath, lease);
			for (const socket of connections) socket.destroy();
			ownerServer.close();
			if (readdirSync(lifetimeDirectory).some((name) => name.startsWith("host-") && name.endsWith(".json"))) {
				const result = spawnSync(process.execPath, reaperLaunchArguments(leasePath), {
					env: reaperEnvironment(),
					encoding: "utf8",
					timeout: 40_000,
				});
				if (result.status !== 0 || result.error) {
					lease.synchronousCleanupInProgress = false;
					writeJsonAtomically(leasePath, lease);
					throw new Error(
						`测试 PTY 退出未确认，保留 fixture 与恢复记录 ${leasePath}: ${result.error?.message ?? result.stderr}`,
					);
				}
			} else {
				rmSync(lifetimeDirectory, { recursive: true });
			}
			completed = true;
		},
	};
}

export function bindTestPtyLifetimeToChildEnvironment(
	environment: NodeJS.ProcessEnv,
	lifetime: ReturnType<typeof createIsolatedTestOwnedPtyHostLifetime>,
): NodeJS.ProcessEnv {
	if (!lifetime.environmentVariables[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE]) return environment;
	return {
		...environment,
		...lifetime.environmentVariables,
		NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preloadPath)}`.trim(),
	};
}

// 仅由测试 preload 在真实 host 入口执行；登记成功之前禁止进入 host 主程序。
export function startTestOwnedPtyHostLifetimeWatcher(leasePath: string): void {
	const lease = leaseSchema.parse(JSON.parse(readFileSync(leasePath, "utf8")));
	if (lease.closed) throw new Error("测试 fixture 寿命已结束，拒绝启动新 PTY host");
	const socketPath = process.argv[process.argv.indexOf("--socket-path") + 1];
	const hostBuildIdentity = process.argv[process.argv.indexOf("--host-build-identity") + 1];
	const generation = readTestOwnedProcessGeneration(process.pid);
	if (!socketPath || !hostBuildIdentity || !generation) throw new Error("测试 PTY host 启动身份不完整");
	const hostRecordPath = join(dirname(leasePath), `host-${process.pid}-${randomUUID()}.json`);
	writeJsonAtomically(hostRecordPath, {
		leaseNonce: lease.nonce,
		process: generation,
		socketPath,
		hostBuildIdentity,
		hostProcessInstanceId: null,
		socketIdentity: null,
		observedProcesses: [generation],
		outcome: "pending",
	} satisfies TestOwnedHostRecord);
	let reaperStarted = false;
	let automaticRecoveryAttemptCount = 0;
	let ownerObservationFailureCount = 0;
	const reconnectOrReap = () => {
		if (reaperStarted) return;
		try {
			const currentLease = leaseSchema.parse(JSON.parse(readFileSync(leasePath, "utf8")));
			if (currentLease.nonce !== lease.nonce) throw new Error("测试 fixture nonce 已变化");
			const ownerAlive = processGenerationStillExists(lease.owner);
			if (ownerAlive && currentLease.closed && currentLease.synchronousCleanupInProgress) {
				setTimeout(reconnectOrReap, 2_000).unref();
				return;
			}
			if ((!ownerAlive || currentLease.closed) && !(ownerAlive && currentLease.synchronousCleanupInProgress)) {
				if (automaticRecoveryAttemptCount >= 3) return;
				const reaper = spawn(process.execPath, reaperLaunchArguments(leasePath), {
					env: reaperEnvironment(),
					detached: true,
					stdio: "ignore",
				});
				automaticRecoveryAttemptCount++;
				reaper.once("exit", (code) => {
					if (code !== 0 && automaticRecoveryAttemptCount < 3) {
						reaperStarted = false;
						setTimeout(reconnectOrReap, 2_000).unref();
					}
				});
				reaper.on("error", () => {
					reaperStarted = false;
					if (automaticRecoveryAttemptCount < 3) setTimeout(reconnectOrReap, 2_000).unref();
				});
				reaper.unref();
				reaperStarted = true;
				return;
			}
		} catch (error) {
			writeJsonAtomically(join(dirname(leasePath), "owner-observation-unknown.json"), { diagnostic: String(error) });
			ownerObservationFailureCount++;
			if (ownerObservationFailureCount < 6) setTimeout(reconnectOrReap, 2_000).unref();
			else {
				// 不持续派生失败的 ps；fixture 关停写入或 guarded 边界会触发新一轮补证。
				const ownerLeaseWatcher = watch(dirname(leasePath), { persistent: false }, (_event, filename) => {
					if (filename !== "fixture-owner-lease.json") return;
					ownerLeaseWatcher.close();
					ownerObservationFailureCount = 0;
					reconnectOrReap();
				});
			}
			return;
		}
		ownerObservationFailureCount = 0;
		const ownerConnection = createConnection(lease.ownerSocketPath);
		ownerConnection.unref();
		ownerConnection.setTimeout(2_000, () => ownerConnection.destroy());
		ownerConnection.once("connect", () => ownerConnection.write(lease.nonce));
		ownerConnection.once("data", (bytes) => {
			if (bytes.toString() !== lease.nonce) ownerConnection.destroy();
			else ownerConnection.setTimeout(0);
		});
		ownerConnection.on("error", () => ownerConnection.destroy());
		ownerConnection.once("close", () => setTimeout(reconnectOrReap, 500).unref());
	};
	reconnectOrReap();
}

async function socketHasNoListener(socketPath: string): Promise<boolean> {
	return await new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const deadline = setTimeout(() => {
			socket.destroy();
			reject(new Error("测试 socket 释放核验超时"));
		}, 1_000);
		socket.once("connect", () => {
			clearTimeout(deadline);
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(deadline);
			socket.destroy();
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(true);
			else reject(error);
		});
	});
}

// 同一非 controller 连接先核验实例、再请求原子离线全停，不抢真实 controller，也不跨 socket 重连发终止。
async function inspectAndRequestOwnedHostTermination(
	record: TestOwnedHostRecord,
	recordPath: string,
): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(record.socketPath);
		const decoder = new AgentSessionPtyHostWireFrameDecoder();
		const requestId = randomUUID();
		let settled = false;
		const finish = (error?: Error, terminationRequested = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			socket.destroy();
			error ? reject(error) : resolve(terminationRequested);
		};
		const deadline = setTimeout(() => finish(new Error("测试 PTY 关闭协议响应超时")), 1_000);
		socket.once("error", finish);
		socket.once("close", () => finish(new Error("测试 PTY 协议连接提前关闭")));
		socket.once("connect", () => {
			socket.write(
				encodeJsonControlMessageFrame({
					type: "hosted_session_cli_client_hello",
					protocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
					hostedSessionCliClientProcessId: process.pid,
				}),
			);
			socket.write(
				encodeJsonControlMessageFrame({ type: "query_agent_session_pty_host_readonly_status_request", requestId }),
			);
		});
		socket.on("data", (bytes: Buffer) => {
			try {
				for (const frame of decoder.push(bytes)) {
					if (frame.kind !== "json_control_message") continue;
					const terminationResponse = z
						.object({
							type: z.literal("terminate_all_hosted_sessions_if_no_controller_response"),
							requestId: z.literal(requestId),
							outcome: z.object({
								kind: z.enum(["termination_requested", "refused_because_controller_connected"]),
							}),
						})
						.safeParse(frame.message);
					if (terminationResponse.success) {
						finish(undefined, terminationResponse.data.outcome.kind === "termination_requested");
						return;
					}
					const parsed = hostStatusSchema.safeParse(frame.message);
					if (!parsed.success) {
						finish(new Error("测试 PTY 返回无效的关闭协议响应"));
						return;
					}
					const status = parsed.data;
					if (
						status.hostProcessId !== record.process.pid ||
						status.hostBuildIdentity !== record.hostBuildIdentity ||
						(record.hostProcessInstanceId !== null &&
							record.hostProcessInstanceId !== status.hostProcessInstanceId)
					) {
						throw new Error("测试 PTY 实例已变化，拒绝终止");
					}
					const socketIdentity = readSocketIdentity(record.socketPath);
					if (record.socketIdentity && !sameSocketIdentity(record.socketIdentity, socketIdentity)) {
						throw new Error("测试 PTY socket 世代已变化，拒绝终止");
					}
					record.hostProcessInstanceId = status.hostProcessInstanceId;
					record.socketIdentity = socketIdentity;
					for (const session of status.hostedSessions.filter((session) => !session.exited)) {
						const generation = readTestOwnedProcessGeneration(session.processId);
						if (
							generation &&
							!record.observedProcesses.some(
								(entry) => entry.pid === generation.pid && entry.startedAt === generation.startedAt,
							)
						)
							record.observedProcesses.push(generation);
					}
					writeJsonAtomically(recordPath, record);
					if (status.controllerProcessId !== null) {
						finish();
						return;
					}
					socket.write(
						encodeJsonControlMessageFrame({
							type: "terminate_all_hosted_sessions_if_no_controller_request",
							requestId,
						}),
					);
				}
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

export async function reclaimTestOwnedPtyHostLifetime(leasePath: string): Promise<boolean> {
	const lease = leaseSchema.parse(JSON.parse(readFileSync(leasePath, "utf8")));
	if (!lease.closed && processGenerationStillExists(lease.owner)) return true;
	const attemptId = randomUUID();
	appendReclamationAuditObservation(leasePath, {
		attemptId,
		event: "recovery_attempt_started",
		controllerPid: process.pid,
		leaseNonce: lease.nonce,
	});
	try {
		writeJsonAtomically(join(dirname(leasePath), "last-recovery-attempt.json"), {
			controller: readTestOwnedProcessGeneration(process.pid),
			startedAtEpochMs: Date.now(),
			leaseNonce: lease.nonce,
		});
	} catch (error) {
		appendReclamationAuditObservation(leasePath, {
			attemptId,
			event: "controller_generation_unknown",
			diagnostic: String(error),
		});
		throw error;
	}
	const hostRecordPaths = readdirSync(dirname(leasePath)).filter((name) => /^host-.*\.json$/.test(name));
	let allCompleted = true;
	const deadline = Date.now() + 30_000;
	for (const name of hostRecordPaths) {
		const recordPath = join(dirname(leasePath), name);
		const record = hostRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
		if (record.leaseNonce !== lease.nonce) throw new Error(`测试 PTY 归属 nonce 不符: ${recordPath}`);
		if (record.outcome === "completed") continue;
		let protocolFailureCount = 0;
		let terminationRequested = false;
		while (Date.now() < deadline) {
			try {
				const liveProcesses = record.observedProcesses.filter(processGenerationStillExists);
				if (liveProcesses.length === 0) {
					const currentSocket = readSocketIdentity(record.socketPath);
					if (sameSocketIdentity(record.socketIdentity, currentSocket)) {
						if (!(await socketHasNoListener(record.socketPath)))
							throw new Error("socket 仍有监听者，保留 unknown");
						if (sameSocketIdentity(record.socketIdentity, readSocketIdentity(record.socketPath)))
							unlinkSync(record.socketPath);
					}
					record.outcome = "completed";
					delete record.diagnostic;
					break;
				}
				if (
					!terminationRequested &&
					liveProcesses.some((entry) => entry.pid === record.process.pid) &&
					protocolFailureCount < 6
				) {
					terminationRequested = await inspectAndRequestOwnedHostTermination(record, recordPath);
				}
			} catch (error) {
				protocolFailureCount++;
				if (record.diagnostic !== String(error))
					appendReclamationAuditObservation(leasePath, {
						attemptId,
						event: "resource_observation_unknown",
						hostProcess: record.process,
						diagnostic: String(error),
					});
				record.diagnostic = String(error);
			}
			writeJsonAtomically(recordPath, record);
			await delay(500);
		}
		if (record.outcome !== "completed") {
			record.outcome = "unknown";
			record.diagnostic ??= "有界回收未确认退出；下次 guarded 启动按同一 lease/世代自动补证";
			allCompleted = false;
		}
		writeJsonAtomically(recordPath, record);
		appendReclamationAuditObservation(leasePath, {
			attemptId,
			event: "host_reclamation_finished",
			hostProcess: record.process,
			hostProcessInstanceId: record.hostProcessInstanceId,
			observedProcesses: record.observedProcesses,
			outcome: record.outcome,
			diagnostic: record.diagnostic,
		});
	}
	if (
		allCompleted &&
		sameSocketIdentity(lease.ownerSocketIdentity, readSocketIdentity(lease.ownerSocketPath)) &&
		(await socketHasNoListener(lease.ownerSocketPath)) &&
		sameSocketIdentity(lease.ownerSocketIdentity, readSocketIdentity(lease.ownerSocketPath))
	)
		unlinkSync(lease.ownerSocketPath);
	return allCompleted;
}

export async function recoverAbandonedTestPtyHostLifetimes(recordsDirectory: string): Promise<void> {
	if (!existsSync(recordsDirectory)) return;
	for (const name of readdirSync(recordsDirectory)) {
		if (!name.startsWith("fixture-lifetime-")) continue;
		const leasePath = join(recordsDirectory, name, "fixture-owner-lease.json");
		if (!existsSync(leasePath)) continue;
		try {
			const records = readdirSync(dirname(leasePath)).filter((entry) => /^host-.*\.json$/.test(entry));
			if (records.length === 0) {
				const lease = leaseSchema.parse(JSON.parse(readFileSync(leasePath, "utf8")));
				if (!lease.closed && processGenerationStillExists(lease.owner)) continue;
				if (await reclaimTestOwnedPtyHostLifetime(leasePath)) rmSync(dirname(leasePath), { recursive: true });
				continue;
			}
			if (
				records.every(
					(entry) =>
						hostRecordSchema.parse(JSON.parse(readFileSync(join(dirname(leasePath), entry), "utf8"))).outcome ===
						"completed",
				)
			)
				continue;
			if (!(await reclaimTestOwnedPtyHostLifetime(leasePath)))
				process.stderr.write(`测试 PTY 恢复仍有缺证: ${leasePath}\n`);
		} catch (error) {
			process.stderr.write(`测试 PTY 恢复保留 unknown: ${leasePath}: ${String(error)}\n`);
		}
	}
}
