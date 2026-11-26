import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	fingerprintLocalDeploymentDistribution,
	localDeploymentGlobalCliLinkMatchesPublishedEntrypoint,
	verifyLocalDeploymentPublishedFiles,
} from "../../../src/deployment/local-deployment-distribution-manifest";
import { createTempDir } from "../../utilities/temp-dir";

describe("发布目录的构建独占文件核验", () => {
	it("只复用指向已发布可执行入口的 CLI 链接，缺失、错指和成环可进入重链", async () => {
		const directory = createTempDir("local-deployment-global-cli-link-");
		onTestFinished(directory.cleanup);
		const binary = join(directory.path, "node");
		const link = join(directory.path, "kanban");
		const cli = join(directory.path, "cli.js");
		await writeFile(cli, "发布入口", { mode: 0o755 });
		const matches = () => localDeploymentGlobalCliLinkMatchesPublishedEntrypoint(binary, directory.path);
		expect(await matches()).toBe(false);
		await symlink(cli, link);
		expect(await matches()).toBe(true);
		await chmod(cli, 0o644);
		expect(await matches()).toBe(false);
		await unlink(link);
		await symlink(link, link);
		expect(await matches()).toBe(false);
		await unlink(link);
		const otherCli = join(directory.path, "other-cli.js");
		await writeFile(otherCli, "其他入口", { mode: 0o755 });
		await symlink(otherCli, link);
		expect(await matches()).toBe(false);
	});

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
