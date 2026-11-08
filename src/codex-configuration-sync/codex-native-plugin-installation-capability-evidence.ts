import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	readPosixProcessResourceTable,
	readProcessCommandLinesForProcessIds,
} from "../diagnostics/posix-process-table-with-resource-columns-reader";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { verifyCodexNativeSharedPluginInstallationCapability } from "./codex-native-plugin-installation-capability-verification";

const executeFile = promisify(execFile);
const probeProtocolRevision = 1;
const nativeCapabilityProbeRetryDelayMs = 30_000;
const nativeCapabilityProbeRetryWindowCooldownMs = 15 * 60_000;
const activeNativeCapabilityProbeProcessSchema = z.object({
	processId: z.number().int().positive(),
	commandMarker: z.string(),
});
const nativePluginInstallationCapabilityEvidenceRecordSchema = z.object({
	schemaVersion: z.literal(1),
	probeProtocolRevision: z.number().int(),
	status: z.enum(["running", "supported", "unsupported", "retry_pending"]),
	nativeExecutableRealPath: z.string(),
	nativeExecutableIdentityDigest: z.string(),
	nativeBinaryVersion: z.string().nullable(),
	executableSearchPath: z.string().optional(),
	verificationWorkingDirectoryPath: z.string().optional(),
	evidencePath: z.string(),
	attemptCount: z.number().int().nonnegative(),
	nextAttemptAtMs: z.number(),
	observedAtMs: z.number(),
	reason: z.string(),
	activeNativeProcess: activeNativeCapabilityProbeProcessSchema.nullable(),
	isolatedProbeDirectoryPath: z.string().nullable(),
});
export type CodexNativePluginInstallationCapabilityEvidence = z.infer<
	typeof nativePluginInstallationCapabilityEvidenceRecordSchema
>;
const inFlightCapabilityVerificationOperationsByEvidencePath = new Map<
	string,
	Promise<CodexNativePluginInstallationCapabilityEvidence>
>();

async function nativePluginInstallationCapabilityEvidenceRootDirectoryPath(runtimeHomeDirectoryPath: string) {
	await mkdir(runtimeHomeDirectoryPath, { recursive: true, mode: 0o700 });
	return join(await realpath(runtimeHomeDirectoryPath), "codex-native-plugin-installation-capability-evidence");
}

async function assertOrdinaryOwnedDirectory(path: string) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
		throw new Error("Codex 能力核验证据目录归属异常，保留现场。");
}

async function resolveNativeExecutableFileIdentity(binary: string, environment: NodeJS.ProcessEnv, cwd: string) {
	for (const candidate of isAbsolute(binary) || binary.includes("/")
		? [resolve(cwd, binary)]
		: (environment.PATH ?? process.env.PATH ?? "")
				.split(delimiter)
				.map((directory) => resolve(cwd, directory, binary))) {
		try {
			const path = await realpath(candidate);
			const metadata = await lstat(path, { bigint: true });
			if (!metadata.isFile()) continue;
			return {
				path,
				digest: createHash("sha256")
					.update(
						JSON.stringify([
							path,
							`${metadata.dev}`,
							`${metadata.ino}`,
							`${metadata.size}`,
							`${metadata.mtimeNs}`,
						]),
					)
					.digest("hex"),
			};
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	throw new Error("实际 Codex 程序或其依赖暂不可读，等待文件恢复后自动核验。");
}

async function readCodexNativePluginInstallationCapabilityEvidence(path: string) {
	try {
		if (!(await lstat(path)).isFile()) throw new Error("Codex 能力证据不是普通文件，保留现场。");
		const record = nativePluginInstallationCapabilityEvidenceRecordSchema.parse(
			JSON.parse(await readFile(path, "utf8")),
		);
		if (record.evidencePath !== path) throw new Error("Codex 能力证据路径归属不符。");
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function persistCodexNativePluginInstallationCapabilityEvidence(
	record: CodexNativePluginInstallationCapabilityEvidence,
) {
	await lockedFileSystem.writeTextFileAtomic(
		record.evidencePath,
		JSON.stringify(nativePluginInstallationCapabilityEvidenceRecordSchema.parse(record)),
		{
			lock: null,
			durable: true,
			fileMode: 0o600,
		},
	);
}

export async function prepareCodexNativePluginInstallationCapabilityEvidence(input: {
	binary: string;
	environment?: NodeJS.ProcessEnv;
	workingDirectory?: string;
	runtimeHomeDirectoryPath?: string;
	expectedLegacyEvidencePath?: string;
}): Promise<CodexNativePluginInstallationCapabilityEvidence> {
	const runtimeHomeDirectoryPath = input.runtimeHomeDirectoryPath ?? getRuntimeHomePath();
	const environment = { ...(input.environment ?? process.env) };
	environment.PATH ??= process.env.PATH ?? "";
	const verificationWorkingDirectoryPath = resolve(input.workingDirectory ?? process.cwd());
	const native = await resolveNativeExecutableFileIdentity(
		input.binary,
		environment,
		verificationWorkingDirectoryPath,
	);
	const dependency = await resolveNativeExecutableFileIdentity(
		"git",
		environment,
		verificationWorkingDirectoryPath,
	).catch(() => null);
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				probeProtocolRevision,
				native.digest,
				dependency?.digest,
				process.platform,
				process.arch,
				environment.PATH ?? process.env.PATH,
			]),
		)
		.digest("hex");
	const root = await nativePluginInstallationCapabilityEvidenceRootDirectoryPath(runtimeHomeDirectoryPath);
	await assertOrdinaryOwnedDirectory(root);
	const directory = join(root, key);
	const path = join(directory, "capability-evidence.json");
	if (input.expectedLegacyEvidencePath && input.expectedLegacyEvidencePath !== path)
		throw new Error("历史能力证据缺少原 PATH，当前环境无法复原同一证据身份，等待原启动环境补证。");
	await assertOrdinaryOwnedDirectory(directory);
	const existingOperation = inFlightCapabilityVerificationOperationsByEvidencePath.get(path);
	if (existingOperation) return existingOperation;
	const operation = lockedFileSystem
		.withLock({ type: "directory", path: directory }, async () => {
			let record = await readCodexNativePluginInstallationCapabilityEvidence(path);
			if (
				record &&
				(record.nativeExecutableIdentityDigest !== native.digest ||
					record.probeProtocolRevision !== probeProtocolRevision)
			)
				throw new Error("Codex 能力记录与实际程序身份不符，保留现场。");
			if (record?.status === "supported" || record?.status === "unsupported") return record;
			if (record?.status === "running" && !record.activeNativeProcess && record.isolatedProbeDirectoryPath) {
				if (!record.isolatedProbeDirectoryPath.startsWith(`${directory}/isolated-probe-attempt-`))
					throw new Error("Codex 隔离核验目录归属异常，保留现场。");
				// 覆盖 spawn 已开始、PID 回执尚未落盘时控制器退出的窗口。
				try {
					const processes = await readPosixProcessResourceTable();
					if (!processes.some((processRow) => processRow.processId === process.pid))
						throw new Error("进程表缺少当前控制器，不能证明原生进程已退出。");
					const commands = await readProcessCommandLinesForProcessIds(
						processes.map((processRow) => processRow.processId),
						{ requireSuccessfulCommandExecution: true },
					);
					for (const processRow of processes) {
						if (commands.has(processRow.processId)) continue;
						try {
							process.kill(processRow.processId, 0);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
						}
						throw new Error("命令表缺少尚未确证退出的进程，不能排除原生进程仍在运行。");
					}
					for (const [processId, command] of commands)
						if (command.includes(record.isolatedProbeDirectoryPath)) {
							record.activeNativeProcess = { processId, commandMarker: record.isolatedProbeDirectoryPath };
							break;
						}
				} catch {
					record.reason = "前一次隔离原生进程的退出状态暂不可核验，保留运行记录并等待自动补证。";
					record.nextAttemptAtMs = Date.now() + nativeCapabilityProbeRetryDelayMs;
					await persistCodexNativePluginInstallationCapabilityEvidence(record);
					return record;
				}
			}
			if (record?.activeNativeProcess) {
				const active = record.activeNativeProcess;
				if (!active.commandMarker.startsWith(`${directory}/`)) throw new Error("隔离原生进程的命令归属异常。");
				let nativeProcessExitConfirmed = false;
				try {
					process.kill(active.processId, 0);
				} catch (error) {
					nativeProcessExitConfirmed = (error as NodeJS.ErrnoException).code === "ESRCH";
				}
				if (!nativeProcessExitConfirmed) {
					const commands = await readProcessCommandLinesForProcessIds([active.processId], {
						requireSuccessfulCommandExecution: true,
					}).catch(() => new Map<number, string>());
					record.status = "retry_pending";
					record.reason = commands.get(active.processId)?.includes(active.commandMarker)
						? "前一次隔离原生进程尚未退出，等待完成后自动补证。"
						: "前一次隔离原生进程的退出状态暂不可核验，保留原身份并等待自动补证。";
					record.nextAttemptAtMs = Date.now() + nativeCapabilityProbeRetryDelayMs;
					await persistCodexNativePluginInstallationCapabilityEvidence(record);
					return record;
				}
			}
			if (record && record.nextAttemptAtMs > Date.now()) return record;
			// 每三个失败尝试进入较长冷却；累计次数与逐次原件不重置，重启后仍可有界接续。
			if (
				record &&
				record.attemptCount % 3 === 0 &&
				Date.now() < record.observedAtMs + nativeCapabilityProbeRetryWindowCooldownMs
			) {
				record.nextAttemptAtMs = record.observedAtMs + nativeCapabilityProbeRetryWindowCooldownMs;
				await persistCodexNativePluginInstallationCapabilityEvidence(record);
				return record;
			}
			let version: string | null = null;
			try {
				version =
					(
						await executeFile(native.path, ["--version"], {
							env: environment,
							cwd: verificationWorkingDirectoryPath,
							timeout: 3_000,
							maxBuffer: 4096,
						})
					).stdout.trim() || null;
			} catch {
				/* 版本仅作诊断；行为才决定资格。 */
			}
			const attemptCount = (record?.attemptCount ?? 0) + 1;
			const isolatedProbeDirectoryPath = join(directory, `isolated-probe-attempt-${attemptCount}-${randomUUID()}`);
			await assertOrdinaryOwnedDirectory(isolatedProbeDirectoryPath);
			record = {
				schemaVersion: 1,
				probeProtocolRevision,
				status: "running",
				nativeExecutableRealPath: native.path,
				nativeExecutableIdentityDigest: native.digest,
				nativeBinaryVersion: version,
				executableSearchPath: environment.PATH,
				verificationWorkingDirectoryPath,
				evidencePath: path,
				attemptCount,
				nextAttemptAtMs: Date.now() + nativeCapabilityProbeRetryDelayMs,
				observedAtMs: Date.now(),
				reason: "正在隔离核验实际插件安装能力。",
				activeNativeProcess: null,
				isolatedProbeDirectoryPath,
			};
			await persistCodexNativePluginInstallationCapabilityEvidence(record);
			const activeRecord = record;
			try {
				const result = await verifyCodexNativeSharedPluginInstallationCapability({
					nativeExecutableRealPath: native.path,
					isolatedProbeDirectoryPath,
					environment,
					recordActiveNativeProcess: async (active) => {
						activeRecord.activeNativeProcess = active;
						await persistCodexNativePluginInstallationCapabilityEvidence(activeRecord);
					},
				});
				const after = await resolveNativeExecutableFileIdentity(
					input.binary,
					environment,
					verificationWorkingDirectoryPath,
				);
				if (after.digest !== native.digest) throw new Error("原生程序在核验过程中变化，等待新文件身份重新核验。");
				record.status = result.status;
				record.reason = result.reason;
			} catch (error) {
				record.status = "retry_pending";
				record.reason = error instanceof Error ? error.message : "隔离能力核验暂不可用。";
			}
			record.observedAtMs = Date.now();
			record.nextAttemptAtMs =
				Date.now() +
				(attemptCount % 3 === 0 ? nativeCapabilityProbeRetryWindowCooldownMs : nativeCapabilityProbeRetryDelayMs);
			await persistCodexNativePluginInstallationCapabilityEvidence(record);
			await lockedFileSystem.writeTextFileAtomic(
				join(isolatedProbeDirectoryPath, "verification-result.json"),
				JSON.stringify(record),
				{ lock: null, durable: true, fileMode: 0o600 },
			);
			return record;
		})
		.finally(() => inFlightCapabilityVerificationOperationsByEvidencePath.delete(path));
	inFlightCapabilityVerificationOperationsByEvidencePath.set(path, operation);
	return operation;
}

let pendingCapabilityEvidenceRecoveryOperation: Promise<void> | undefined;
export function recoverPendingCodexNativePluginInstallationCapabilityEvidence(
	environment: NodeJS.ProcessEnv = process.env,
) {
	if (pendingCapabilityEvidenceRecoveryOperation) return pendingCapabilityEvidenceRecoveryOperation;
	const runtimeHomeDirectoryPath = getRuntimeHomePath();
	const recoveryEnvironment = { ...environment };
	pendingCapabilityEvidenceRecoveryOperation = (async () => {
		let entries: string[];
		const evidenceRootDirectoryPath =
			await nativePluginInstallationCapabilityEvidenceRootDirectoryPath(runtimeHomeDirectoryPath);
		try {
			entries = await readdir(evidenceRootDirectoryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (!/^[a-f0-9]{64}$/.test(entry)) continue;
			try {
				const record = await readCodexNativePluginInstallationCapabilityEvidence(
					join(evidenceRootDirectoryPath, entry, "capability-evidence.json"),
				);
				if (!record || !["running", "retry_pending"].includes(record.status) || record.nextAttemptAtMs > Date.now())
					continue;
				await prepareCodexNativePluginInstallationCapabilityEvidence({
					binary: record.nativeExecutableRealPath,
					environment: { ...recoveryEnvironment, PATH: record.executableSearchPath ?? recoveryEnvironment.PATH },
					workingDirectory: record.verificationWorkingDirectoryPath,
					expectedLegacyEvidencePath: record.executableSearchPath === undefined ? record.evidencePath : undefined,
					runtimeHomeDirectoryPath,
				});
			} catch {
				// 单份证据缺失或损坏只暂停对应能力，不阻塞其他已授权的自动恢复。
			}
		}
	})().finally(() => {
		pendingCapabilityEvidenceRecoveryOperation = undefined;
	});
	return pendingCapabilityEvidenceRecoveryOperation;
}

export function waitForPendingCodexNativePluginInstallationCapabilityEvidenceRecovery() {
	return pendingCapabilityEvidenceRecoveryOperation?.catch(() => {}) ?? Promise.resolve();
}
