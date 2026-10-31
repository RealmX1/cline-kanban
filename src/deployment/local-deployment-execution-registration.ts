import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { runGit } from "../workspace/git-utils";
import { readLocalDeploymentExecution } from "./local-deployment-execution";
import type { LocalDeploymentExecutionManifest } from "./local-deployment-execution-contract";

type DeploymentRecordReceipt = Record<string, unknown>;

export async function recordBoundLocalDeploymentExecutionOnce(input: {
	executionDirectory: string;
	sourceCheckoutPath?: string;
	newCommit?: string;
	record: (manifest: LocalDeploymentExecutionManifest, requestedAtIso: string) => Promise<DeploymentRecordReceipt>;
}): Promise<DeploymentRecordReceipt> {
	const directory = resolve(input.executionDirectory);
	const execution = await readLocalDeploymentExecution(directory);
	const manifest = execution.manifest;
	if (input.sourceCheckoutPath && resolve(input.sourceCheckoutPath) !== resolve(manifest.sourceCheckoutPath)) {
		throw new Error("登记源码目录与部署执行绑定不一致");
	}
	const sourceCommit = await runGit(manifest.sourceCheckoutPath, [
		"rev-parse",
		input.newCommit ?? manifest.candidateSourceCommit,
	]);
	if (!sourceCommit.ok || sourceCommit.stdout.trim() !== manifest.candidateSourceCommit)
		throw new Error("登记候选与部署执行绑定不一致");
	if (
		!execution.observations.some(
			(item) =>
				item.stage === "runtime_validation" &&
				(item.kind === "command_succeeded" || item.kind === "effect_verified"),
		)
	) {
		throw new Error("本次执行尚未记录运行实例核验通过，不能提前登记部署");
	}
	return await lockedFileSystem.withLock(
		{ type: "directory", path: directory, lockfileName: ".deployment-registration.lock" },
		async () => {
			const receiptPath = join(directory, "deployment-record-receipt.json");
			try {
				const receipt: DeploymentRecordReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
				if (
					receipt.ok !== true ||
					receipt.deploymentId !== manifest.executionId ||
					receipt.workspaceId !== manifest.workspaceId ||
					receipt.deployedSourceCommit !== manifest.candidateSourceCommit
				)
					throw new Error("部署登记回执与执行绑定不一致，保留原件");
				return receipt;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			const intentPath = join(directory, "deployment-registration-intent.json");
			let requestedAtIso = new Date().toISOString();
			try {
				const intent: { executionId: string; requestedAtIso: string } = JSON.parse(
					await readFile(intentPath, "utf8"),
				);
				if (intent.executionId !== manifest.executionId || !Number.isFinite(Date.parse(intent.requestedAtIso)))
					throw new Error("登记意图身份或时间无效");
				requestedAtIso = intent.requestedAtIso;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				await lockedFileSystem.writeJsonFileAtomic(
					intentPath,
					{ executionId: manifest.executionId, requestedAtIso },
					{ lock: null, durable: true, fileMode: 0o600 },
				);
			}
			const receipt = await input.record(manifest, requestedAtIso);
			if (
				receipt.ok !== true ||
				receipt.deploymentId !== manifest.executionId ||
				receipt.workspaceId !== manifest.workspaceId ||
				receipt.deployedSourceCommit !== manifest.candidateSourceCommit
			) {
				throw new Error("登记结果未证明同一执行、workspace 与候选；保留意图，不能创建替代部署");
			}
			await lockedFileSystem.writeJsonFileAtomic(receiptPath, receipt, {
				lock: null,
				durable: true,
				fileMode: 0o600,
			});
			return receipt;
		},
	);
}
