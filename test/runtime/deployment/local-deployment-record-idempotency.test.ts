import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDeployMarkerPath } from "../../../src/deployment/deploy-marker";
import {
	createDeploymentGroup,
	getPostDeployVerificationStatePath,
} from "../../../src/deployment/post-deploy-verification-state";
import { createTempDir } from "../../utilities/temp-dir";

describe("部署执行身份与 PDV 建组幂等", () => {
	it("组落盘后保留旧 marker，重试时按登记的前驱身份补齐 marker", async () => {
		const isolatedHome = createTempDir("local-deployment-marker-repair-");
		onTestFinished(() => {
			vi.unstubAllEnvs();
			isolatedHome.cleanup();
		});
		vi.stubEnv("HOME", isolatedHome.path);
		vi.stubEnv("USERPROFILE", isolatedHome.path);
		const previous = {
			deploymentId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-workspace",
			deployedSourceCommit: "a".repeat(40),
			previousDeployedSourceCommit: null,
			sourceCheckoutPath: isolatedHome.path,
			packageVersion: "0.1.68",
			tasks: [],
		};
		await createDeploymentGroup(previous, "2026-10-31T12:00:00Z");
		const previousMarker = await readFile(getDeployMarkerPath(), "utf8");
		const candidate = {
			...previous,
			deploymentId: "cf2574ad-9e8a-496c-b842-9cab57aa815a",
			deployedSourceCommit: "b".repeat(40),
			previousDeployedSourceCommit: previous.deployedSourceCommit,
		};
		await createDeploymentGroup(candidate, "2026-10-31T13:00:00Z");
		await writeFile(getDeployMarkerPath(), previousMarker);
		await createDeploymentGroup(candidate, "2026-10-31T14:00:00Z");
		expect(JSON.parse(await readFile(getDeployMarkerPath(), "utf8"))).toMatchObject({
			deploymentId: candidate.deploymentId,
			deployedAtIso: "2026-10-31T13:00:00Z",
		});
		expect(JSON.parse(await readFile(getPostDeployVerificationStatePath(), "utf8")).deploymentGroups).toHaveLength(2);
	});

	it.each(["2026-10-31T13:00:00Z", "2026-10-31T11:00:00Z"])(
		"后来接受的组时间为 %s 时，旧执行重试均不能回退 marker",
		async (laterAcceptedAtIso) => {
			const isolatedHome = createTempDir("local-deployment-record-idempotency-");
			onTestFinished(() => {
				vi.unstubAllEnvs();
				isolatedHome.cleanup();
			});
			vi.stubEnv("HOME", isolatedHome.path);
			vi.stubEnv("USERPROFILE", isolatedHome.path);
			const input = {
				deploymentId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
				workspaceId: "isolated-workspace",
				deployedSourceCommit: "a".repeat(40),
				previousDeployedSourceCommit: null,
				sourceCheckoutPath: isolatedHome.path,
				packageVersion: "0.1.68",
				tasks: [],
			};
			await createDeploymentGroup(input, "2026-10-31T12:00:00Z");
			await createDeploymentGroup(
				{
					...input,
					deploymentId: "cf2574ad-9e8a-496c-b842-9cab57aa815a",
					deployedSourceCommit: "b".repeat(40),
					previousDeployedSourceCommit: input.deployedSourceCommit,
				},
				laterAcceptedAtIso,
			);
			const markerBeforeRetry = await readFile(getDeployMarkerPath(), "utf8");
			const retried = await createDeploymentGroup(input, "2026-10-31T14:00:00Z");
			expect(retried.group.deployedAtIso).toBe("2026-10-31T12:00:00Z");
			expect(JSON.parse(await readFile(getPostDeployVerificationStatePath(), "utf8")).deploymentGroups).toHaveLength(
				2,
			);
			expect(await readFile(getDeployMarkerPath(), "utf8")).toBe(markerBeforeRetry);
			await expect(
				createDeploymentGroup({ ...input, deployedSourceCommit: "c".repeat(40) }, "2026-10-31T15:00:00Z"),
			).rejects.toThrow("绑定");
		},
	);
});
