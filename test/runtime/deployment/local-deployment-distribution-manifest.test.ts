import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	fingerprintLocalDeploymentDistribution,
	verifyLocalDeploymentPublishedFiles,
} from "../../../src/deployment/local-deployment-distribution-manifest";
import { createTempDir } from "../../utilities/temp-dir";

describe("发布目录的构建独占文件核验", () => {
	it("候选文件相同但 web-ui 仍有陈旧文件时不能放行，非构建顶层文件仍保留", async () => {
		const directory = createTempDir("local-deployment-publication-owned-files-");
		onTestFinished(directory.cleanup);
		const candidate = join(directory.path, "candidate");
		const published = join(directory.path, "published");
		for (const root of [candidate, published]) {
			await mkdir(join(root, "web-ui/assets"), { recursive: true });
			await writeFile(join(root, "web-ui/index.html"), "新入口");
			await writeFile(join(root, "web-ui/assets/current.js"), "新资源");
		}
		await writeFile(join(published, "unowned.txt"), "原有非构建文件");
		await writeFile(join(published, "web-ui/assets/stale.js"), "陈旧资源");
		const input = {
			candidateDistributionDirectoryPath: candidate,
			distributionDirectoryPath: published,
			candidateDistributionSha256: (await fingerprintLocalDeploymentDistribution(candidate))
				.candidateDistributionSha256,
		};
		expect(await verifyLocalDeploymentPublishedFiles(input)).toBe(false);
		await unlink(join(published, "web-ui/assets/stale.js"));
		expect(await verifyLocalDeploymentPublishedFiles(input)).toBe(true);
		await symlink(join(published, "unowned.txt"), join(published, "web-ui/assets/symbolic-extra.js"));
		expect(await verifyLocalDeploymentPublishedFiles(input)).toBe(false);
	});
});
