import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { updateRvfAutomaticCloseoutRecords } from "./rvf-automatic-closeout-store";

const execFileAsync = promisify(execFile);
// 与 Python helper 使用同一原生代际；查询能力缺失时保留未知，绝不把 pid 复用当作原操作。
const nativeProcessIdentityPythonScript = `
import ctypes, json, os, sys
pid = int(sys.argv[1])
if sys.platform == 'linux':
    boot = open('/proc/sys/kernel/random/boot_id').read().strip().lower()
    stat = open('/proc/%d/stat' % pid).read()
    start = 'linux-proc-start:' + stat[stat.rfind(')') + 2:].split()[19]
elif sys.platform == 'darwin':
    libc = ctypes.CDLL(None, use_errno=True)
    size = ctypes.c_size_t(256)
    value = ctypes.create_string_buffer(size.value)
    if libc.sysctlbyname(b'kern.bootsessionuuid', value, ctypes.byref(size), None, 0) != 0: raise OSError(ctypes.get_errno())
    boot = value.value.decode().lower()
    class ProcessInfo(ctypes.Structure):
        _fields_ = [('prefix', ctypes.c_uint32 * 12), ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32), ('remaining', ctypes.c_uint32 * 6), ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
    info = ProcessInfo()
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info): raise OSError(ctypes.get_errno())
    start = 'darwin-proc-start:%d:%d' % (info.start_sec, info.start_usec)
else: raise RuntimeError('unsupported native process identity')
print(json.dumps(dict(pid=pid, boot_session_id=boot, process_start_id=start)))
`;
interface NativeProcessLifetimeIdentity {
	pid: number;
	boot_session_id: string;
	process_start_id: string;
}
async function readNativeProcessLifetimeIdentity(pid: number): Promise<NativeProcessLifetimeIdentity | null> {
	return execFileAsync("python3", ["-c", nativeProcessIdentityPythonScript, String(pid)], {
		timeout: 5_000,
		maxBuffer: 8192,
	})
		.then(({ stdout }) => JSON.parse(stdout) as NativeProcessLifetimeIdentity)
		.catch(() => null);
}
let currentNativeProcessIdentity: Promise<NativeProcessLifetimeIdentity | null> | undefined;
const locallyOwnedTerminalDeliveryOperationIds = new Set<string>();
function readCurrentNativeProcessIdentity(): Promise<NativeProcessLifetimeIdentity | null> {
	currentNativeProcessIdentity ??= readNativeProcessLifetimeIdentity(process.pid);
	return currentNativeProcessIdentity;
}

export function normalRvfCloseoutReconciliationContext(storePath: string, record: RvfAutomaticCloseoutRecord) {
	return {
		store_path: storePath,
		workspace_id: record.workspaceId,
		task_id: record.taskId,
		decision_token: record.receipt.decision_token,
		run_id: record.runId,
		run_directory: record.runDirectory,
	};
}
type NormalRvfCloseoutReconciliationContext = ReturnType<typeof normalRvfCloseoutReconciliationContext>;

export interface NormalRvfCloseoutQuiescenceEvidence {
	schema: "kanban-normal-closeout-quiescence/v1";
	operation_id: string;
	observed_at: string;
	workspace_id: string;
	task_id: string;
	decision_token: string;
	run_id: string;
	run_directory: string;
	conversation_session_id: string;
	native_session_id: string;
	runtime_session_incarnation_id: string;
	delivery_idempotency_key: string;
	queued_delivery_absent: true;
	terminal_delivery_pending: false;
	native_control_verified_idle: true;
	native_turns_sha256: string;
	delivery_ledger_sha256: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** 与 Python Path.resolve(strict=False) 一致，缺失 run 仍解析已有父目录及悬空符号链接。 */
async function canonicalizeRvfRunDirectoryWithMissingComponents(path: string): Promise<string> {
	const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
	const root = parse(absolute).root;
	let current = root;
	const pending = absolute.slice(root.length).split(sep);
	let followedSymbolicLinks = 0;
	while (pending.length) {
		const component = pending.shift();
		if (!component || component === ".") continue;
		if (component === "..") {
			current = dirname(current);
			continue;
		}
		const candidate = join(current, component);
		let metadata: Stats;
		try {
			metadata = await lstat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			current = candidate;
			continue;
		}
		if (!metadata.isSymbolicLink()) {
			current = candidate;
			continue;
		}
		if (++followedSymbolicLinks > 40) throw new Error("原 run 路径的符号链接无法确定唯一身份。");
		const target = await readlink(candidate);
		if (isAbsolute(target)) {
			const targetRoot = parse(target).root;
			current = targetRoot;
			pending.unshift(...target.slice(targetRoot.length).split(sep));
		} else pending.unshift(...target.split(sep));
	}
	return current;
}

export async function readNormalRvfCloseoutSuppression(
	worktree: string,
	originalRunDirectory: string | null,
): Promise<{
	reason: "active_backup_route_ownership" | "original_run_consumed_by_backup_route";
	controlDirectory: string;
} | null> {
	const gitDirectory = await worktreeGitDirectory(worktree);
	if (gitDirectory === null) return null;
	const controlDirectory = join(gitDirectory, "rvf-independent-backup-route");
	if (await exists(join(controlDirectory, "active-owner")))
		return { reason: "active_backup_route_ownership", controlDirectory };
	if (originalRunDirectory !== null) {
		const canonicalRunDirectory = await canonicalizeRvfRunDirectoryWithMissingComponents(originalRunDirectory);
		const consumed = join(
			controlDirectory,
			"consumed-original-runs",
			`${createHash("sha256").update(canonicalRunDirectory).digest("hex")}.json`,
		);
		if (await exists(consumed)) return { reason: "original_run_consumed_by_backup_route", controlDirectory };
	}
	return null;
}

async function worktreeGitDirectory(worktree: string): Promise<string | null> {
	const entry = join(worktree, ".git");
	try {
		if ((await stat(entry)).isDirectory()) return await realpath(entry);
		const text = await readFile(entry, "utf8");
		if (!text.startsWith("gitdir: ")) throw new Error("worktree 的 Git 归属记录无效");
		return await realpath(resolve(worktree, text.slice(8).trim()));
	} catch (error) {
		// 非 Git 测试模型和尚未物化的目录不由此协议声明身份；原生资格检查仍由原流程负责。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeDurableReservation(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const writing = `${path}.${randomUUID()}.writing`;
	const handle = await open(writing, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(writing, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/** 与 RVF 的独立备用路线共享：先登记再检查 marker，接管方先占位再等待登记清空。 */
export async function withNormalRvfCloseoutMutation<T>(
	worktree: string,
	originalRunDirectory: string | null,
	operation: () => Promise<T>,
	onSuppressed?: (
		reason: "active_backup_route_ownership" | "original_run_consumed_by_backup_route",
		controlDirectory: string,
	) => Promise<void>,
	reconciliationContext?: NormalRvfCloseoutReconciliationContext,
): Promise<T | undefined> {
	const gitDirectory = await worktreeGitDirectory(worktree);
	if (gitDirectory === null) return operation();
	const control = join(gitDirectory, "rvf-independent-backup-route");
	const operationId = randomUUID();
	const reservation = join(control, "normal-mutations", `${operationId}.json`);
	const value = {
		pid: process.pid,
		process_identity: await readCurrentNativeProcessIdentity(),
		operation_id: operationId,
		operation_state: "running",
		operation: "kanban-automatic-closeout",
		worktree,
		original_run_directory: originalRunDirectory,
		outcome: "in_flight",
		reconciliation_context: reconciliationContext,
	};
	await writeDurableReservation(reservation, value);
	let reservationReleased = false;
	try {
		const suppression = await readNormalRvfCloseoutSuppression(worktree, originalRunDirectory);
		if (suppression) {
			await unlink(reservation);
			reservationReleased = true;
			await onSuppressed?.(suppression.reason, suppression.controlDirectory);
			return undefined;
		}
		const result = await operation();
		await unlink(reservation);
		return result;
	} catch (error) {
		if (!reservationReleased)
			await writeDurableReservation(reservation, { ...value, outcome: "unknown", operation_state: "settled" });
		throw error;
	}
}

async function normalCloseoutDeliveryReservationPath(worktree: string, idempotencyKey: string) {
	const gitDirectory = await worktreeGitDirectory(worktree);
	if (!gitDirectory) return null;
	const operationId = createHash("sha256").update(`kanban-closeout-terminal-delivery:${idempotencyKey}`).digest("hex");
	return {
		path: join(gitDirectory, "rvf-independent-backup-route", "normal-mutations", `${operationId}.json`),
		operationId,
	};
}

/** reservation 跨过异步 validator 返回，直到终端观察到真实终态，覆盖检查与实际写入间的窗口。 */
export async function reserveNormalRvfCloseoutTerminalDelivery(
	storePath: string,
	record: RvfAutomaticCloseoutRecord,
	idempotencyKey: string,
) {
	const reservation = await normalCloseoutDeliveryReservationPath(record.receipt.worktree, idempotencyKey);
	if (!reservation) return false;
	let existing: string | null;
	try {
		existing = await readFile(reservation.path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existing = null;
	}
	if (existing !== null) {
		const value = JSON.parse(existing);
		const currentProcessIdentity = await readCurrentNativeProcessIdentity();
		if (
			value.outcome !== "in_flight" ||
			value.pid !== process.pid ||
			!(
				locallyOwnedTerminalDeliveryOperationIds.has(reservation.operationId) ||
				(currentProcessIdentity &&
					JSON.stringify(value.process_identity) === JSON.stringify(currentProcessIdentity))
			) ||
			JSON.stringify(value.reconciliation_context) !==
				JSON.stringify(normalRvfCloseoutReconciliationContext(storePath, record))
		)
			throw new Error("旧终端投递仍待原生对账，不能重复写入。");
		return false;
	}
	await writeDurableReservation(reservation.path, {
		pid: process.pid,
		process_identity: await readCurrentNativeProcessIdentity(),
		operation_id: reservation.operationId,
		operation_state: "running",
		operation: "kanban-automatic-closeout",
		operation_kind: "terminal_delivery",
		worktree: record.receipt.worktree,
		original_run_directory: record.runDirectory,
		outcome: "in_flight",
		reconciliation_context: normalRvfCloseoutReconciliationContext(storePath, record),
	});
	locallyOwnedTerminalDeliveryOperationIds.add(reservation.operationId);
	return true;
}

export async function settleNormalRvfCloseoutTerminalDelivery(
	worktree: string,
	idempotencyKey: string,
	outcome: "confirmed" | "not_started" | "unknown",
) {
	const reservation = await normalCloseoutDeliveryReservationPath(worktree, idempotencyKey);
	if (!reservation) return;
	let text: string;
	try {
		text = await readFile(reservation.path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (outcome !== "unknown") await unlink(reservation.path);
	else
		await writeDurableReservation(reservation.path, {
			...JSON.parse(text),
			operation_state: "settled",
			outcome: "unknown",
		});
	locallyOwnedTerminalDeliveryOperationIds.delete(reservation.operationId);
}

/** 局部调用已退出仍不代表原生工作已结束；只有控制面补齐静止事实后才归档 unknown。 */
export async function reconcileSettledNormalRvfCloseoutMutations(
	worktree: string,
	context: NormalRvfCloseoutReconciliationContext,
	evidenceFingerprint: string,
	verifyNativeQuiescence: (operationId: string) => Promise<NormalRvfCloseoutQuiescenceEvidence | null>,
): Promise<void> {
	const gitDirectory = await worktreeGitDirectory(worktree);
	if (!gitDirectory) return;
	const control = join(gitDirectory, "rvf-independent-backup-route");
	const directory = join(control, "normal-mutations");
	const reservations = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	for (const name of reservations) {
		if (!/^[a-f0-9-]+\.json$/u.test(name)) continue;
		const path = join(directory, name);
		let originalText: string;
		try {
			originalText = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const value = JSON.parse(originalText);
		const terminalDeliveryPending = value.operation_kind === "terminal_delivery" && value.outcome === "in_flight";
		if (
			value.operation !== "kanban-automatic-closeout" ||
			!((value.outcome === "unknown" && value.operation_state === "settled") || terminalDeliveryPending) ||
			value.operation_id !== name.slice(0, -5) ||
			JSON.stringify(value.reconciliation_context) !== JSON.stringify(context)
		)
			continue;
		if (terminalDeliveryPending && value.pid !== process.pid) {
			// 外部仍活着的 runtime 可能持有尚未落到本 manager 的写入，不能只凭本地空闲释放它。
			try {
				process.kill(value.pid, 0);
				const observedIdentity = await readNativeProcessLifetimeIdentity(value.pid);
				if (
					!value.process_identity ||
					!observedIdentity ||
					JSON.stringify(value.process_identity) === JSON.stringify(observedIdentity)
				)
					continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			}
		}
		// Node 自身不派发独立进程组；若出现外部组声明，交给共享 helper 对账。
		if (value.child_process_groups?.length) continue;
		const previousBudget = value.reconciliation_observation_budget;
		const sameEvidence = previousBudget?.fingerprint === evidenceFingerprint;
		if (sameEvidence && (previousBudget.attempt_count >= 3 || previousBudget.next_attempt_at > Date.now())) continue;
		const checking = {
			...value,
			reconciliation_observation_budget: {
				fingerprint: evidenceFingerprint,
				attempt_count: sameEvidence ? previousBudget.attempt_count + 1 : 1,
				next_attempt_at: Date.now() + 15_000,
			},
		};
		await writeDurableReservation(path, checking);
		originalText = await readFile(path, "utf8");
		const evidence = await verifyNativeQuiescence(value.operation_id).catch(() => null);
		if (!evidence) continue;
		if ((await readFile(path, "utf8").catch(() => null)) !== originalText) continue;
		const settled = {
			...checking,
			outcome: "unknown",
			operation_state: "settled",
			native_outcome_evidence: evidence,
		};
		await writeDurableReservation(path, settled);
		await writeDurableReservation(join(control, "reconciled-normal-mutations", name), settled);
		await unlink(path);
		locallyOwnedTerminalDeliveryOperationIds.delete(value.operation_id);
	}
}

/** 仅追加抑制观察；不把原 run 的失败、暂停或完成状态改写成备用成功。 */
export async function recordIndependentBackupRouteSuppressionObservation(
	storePath: string,
	record: RvfAutomaticCloseoutRecord,
	reason: "active_backup_route_ownership" | "original_run_consumed_by_backup_route",
	controlDirectory: string,
): Promise<void> {
	await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
		records: records.map((entry) =>
			entry.taskId === record.taskId &&
			entry.receipt.decision_token === record.receipt.decision_token &&
			entry.runDirectory === record.runDirectory
				? {
						...entry,
						independentBackupRouteSuppressionObservation: {
							observedAt: Date.now(),
							originalRunDirectory: record.runDirectory,
							controlDirectory,
							reason,
						},
					}
				: entry,
		),
		value: null,
	}));
}
