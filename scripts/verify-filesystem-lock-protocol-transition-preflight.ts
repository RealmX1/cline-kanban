import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as waitForRetiringWriters } from "node:timers/promises";
import { inspectFilesystemLockProtocolTransitionPreflight } from "../src/deployment/filesystem-lock-protocol-transition-preflight";
import { lockedFileSystem } from "../src/fs/locked-file-system";

const arguments_ = process.argv.slice(2);
function requiredArgument(option: string): string {
	const index = arguments_.indexOf(option);
	const value = index < 0 ? undefined : arguments_[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`缺少参数 ${option}。`);
	return value;
}
const inventoryPath = resolve(requiredArgument("--retiring-writer-inventory"));
const evidencePath = resolve(requiredArgument("--evidence-file"));
const expectedCandidateSourceCommit = requiredArgument("--candidate-source-commit");
const expectedRuntimeHomeDirectoryPath = resolve(requiredArgument("--runtime-home"));
const waitDeadlineMs = arguments_.includes("--wait-deadline-ms") ? Number(requiredArgument("--wait-deadline-ms")) : 0;
if (!Number.isFinite(waitDeadlineMs) || waitDeadlineMs < 0) throw new Error("等待预算必须为有限非负毫秒数。");
const deadlineAt = Date.now() + waitDeadlineMs;
const direction = arguments_.includes("--rollback-to-legacy-locks")
	? "rollback_to_legacy_locks"
	: "activate_kernel_write_locks";
await mkdir(dirname(evidencePath), { recursive: true });
while (true) {
	let assessment;
	let retiringWriterInventorySha256: string | null = null;
	try {
		const inventoryText = await readFile(inventoryPath, "utf8");
		retiringWriterInventorySha256 = createHash("sha256").update(inventoryText).digest("hex");
		assessment = await inspectFilesystemLockProtocolTransitionPreflight({
			inventory: JSON.parse(inventoryText),
			expectedCandidateSourceCommit,
			expectedRuntimeHomeDirectoryPath,
			direction,
		});
	} catch (error) {
		assessment = {
			status: "evidence_unavailable",
			candidateSourceCommit: expectedCandidateSourceCommit,
			checkedAtEpochMs: Date.now(),
			recoveryCondition: String(error),
			nextCheckAtEpochMs: Date.now() + 15_000,
		};
	}
	await lockedFileSystem.writeJsonFileAtomic(
		evidencePath,
		{
			...assessment,
			recoveryRunBinding: {
				schemaVersion: 1,
				readOnlyRecoveryProcedure: "inspectFilesystemLockProtocolTransitionPreflight",
				retiringWriterInventoryFilePath: inventoryPath,
				retiringWriterInventorySha256,
				expectedCandidateSourceCommit,
				expectedRuntimeHomeDirectoryPath,
				direction,
				writerLaunchAdmissionMustRemainClosed: true,
				requiredWriterDisposition: "absent_or_replaced_or_system_boot_changed",
				pendingSnapshotProjectionMustBeComplete: direction === "rollback_to_legacy_locks",
				retryIntervalMs: 15_000,
				currentInvocationDeadlineAtEpochMs: deadlineAt,
			},
		},
		{ lock: null, durable: true },
	);
	process.stdout.write(`${JSON.stringify(assessment)}\n`);
	if (assessment.status === "ready_for_protocol_switch") break;
	if (Date.now() >= deadlineAt) {
		process.exitCode = 2;
		break;
	}
	await waitForRetiringWriters(Math.min(15_000, deadlineAt - Date.now()));
}
