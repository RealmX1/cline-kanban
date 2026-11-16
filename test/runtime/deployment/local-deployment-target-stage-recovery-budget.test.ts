import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	readLocalDeploymentTargetStageRecoveryBudget,
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import { createTempDir } from "../../utilities/temp-dir";

describe("部署目标的持久阶段恢复预算", () => {
	it("同一目标跨执行、候选和重启共用门禁；每份相关恢复证据只消费一次", async () => {
		const temporary = createTempDir("local-deployment-target-recovery-budget-");
		onTestFinished(temporary.cleanup);
		const runtimeHome = join(temporary.path, "runtime-home");
		await mkdir(runtimeHome);
		const binding = {
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			runtimeIdentity: { runtimeHomeDirectoryPath: runtimeHome, runtimePort: 39884 },
			distributionDirectoryPath: join(temporary.path, "published-distribution"),
		};
		const input = {
			binding,
			stage: "state_preservation" as const,
			executionDirectory: join(temporary.path, "first-execution"),
			attemptNumber: 1,
			recoveryEvidenceSha256: null,
			recoveryEvidenceReady: false,
		};
		expect(await reserveLocalDeploymentTargetStageAttempt(input)).toBe(true);
		await recordLocalDeploymentTargetStageFailure({
			...input,
			failure: {
				classification: "copy_identity_mismatch",
				logicalResource: join(runtimeHome, "LICENSE"),
				recoveryCondition: "实际冻结执行器的链接保真隔离回归通过",
				originalErrorReference: join(input.executionDirectory, "stderr.txt"),
			},
		});
		const newExecution = {
			...input,
			binding: { ...binding, executionId: "042609d8-7508-4bdc-b202-1d7bd7da8a14" },
			executionDirectory: join(temporary.path, "different-candidate-execution"),
		};
		expect(await reserveLocalDeploymentTargetStageAttempt(newExecution)).toBe(false);
		expect(
			await reserveLocalDeploymentTargetStageAttempt({ ...newExecution, recoveryEvidenceSha256: "a".repeat(64) }),
		).toBe(false);
		const recovered = { ...newExecution, recoveryEvidenceSha256: "b".repeat(64), recoveryEvidenceReady: true };
		expect(await reserveLocalDeploymentTargetStageAttempt(recovered)).toBe(true);
		expect(await reserveLocalDeploymentTargetStageAttempt({ ...recovered, attemptNumber: 2 })).toBe(false);
		expect(await reserveLocalDeploymentTargetStageAttempt({ ...recovered, recoveryEvidenceSha256: null })).toBe(
			false,
		);
		expect(
			await reserveLocalDeploymentTargetStageAttempt({ ...recovered, recoveryEvidenceSha256: "c".repeat(64) }),
		).toBe(true);
		expect(await reserveLocalDeploymentTargetStageAttempt(recovered)).toBe(false);
		const budget = await readLocalDeploymentTargetStageRecoveryBudget(binding, "state_preservation");
		expect(budget?.attempts).toHaveLength(3);
		expect(budget?.blockingFailure?.classification).toBe("copy_identity_mismatch");
	});
});
