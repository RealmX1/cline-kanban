import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withNormalRvfCloseoutMutation } from "../../../src/rvf-automatic-closeout/independent-backup-route-ownership";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("独立备用路线接管", () => {
	it.each(["run_alias", "parent_alias"])("原 run 删除后仍通过 %s 命中同一消费身份", async (aliasKind) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		const parent = join(fixture.fixtureRootDirectoryPath, "original-runs");
		const run = join(parent, "original-run");
		const alias = join(fixture.fixtureRootDirectoryPath, "original-run-alias");
		await mkdir(run, { recursive: true });
		await symlink(aliasKind === "run_alias" ? run : parent, alias);
		const requestedRun = aliasKind === "run_alias" ? alias : join(alias, "original-run");
		const consumed = join(repo.repositoryPath, ".git", "rvf-independent-backup-route", "consumed-original-runs");
		await mkdir(consumed, { recursive: true });
		await writeFile(
			join(
				consumed,
				`${createHash("sha256")
					.update(await realpath(run))
					.digest("hex")}.json`,
			),
			"消费事实",
		);
		await rm(run, { recursive: true });
		let writes = 0;
		await withNormalRvfCloseoutMutation(repo.repositoryPath, requestedRun, async () => {
			writes++;
		});
		expect(writes).toBe(0);
	});
	it("先登记在途动作，接管之后不再执行新的自动收尾", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		const control = join(repo.repositoryPath, ".git", "rvf-independent-backup-route");
		let duplicateWrites = 0;
		await withNormalRvfCloseoutMutation(repo.repositoryPath, null, async () => {
			expect(await readdir(join(control, "normal-mutations"))).toHaveLength(1);
			await mkdir(join(control, "active-owner"));
			await withNormalRvfCloseoutMutation(repo.repositoryPath, null, async () => {
				duplicateWrites++;
			});
			expect(await readdir(join(control, "normal-mutations"))).toHaveLength(1);
		});
		expect(duplicateWrites).toBe(0);
		expect(await readdir(join(control, "normal-mutations"))).toHaveLength(0);
	});

	it("不依赖接管 JSON 能被解析", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		const marker = join(repo.repositoryPath, ".git", "rvf-independent-backup-route", "active-owner");
		await mkdir(marker, { recursive: true });
		await writeFile(join(marker, "identity.json"), "broken");
		let writes = 0;
		await withNormalRvfCloseoutMutation(repo.repositoryPath, null, async () => {
			writes++;
		});
		expect(writes).toBe(0);
	});

	it("已消费的原 run 不再恢复或投递，新 run 仍可执行", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		const consumed = join(repo.repositoryPath, ".git", "rvf-independent-backup-route", "consumed-original-runs");
		await mkdir(consumed, { recursive: true });
		const run = join(fixture.fixtureRootDirectoryPath, "original-run");
		await writeFile(
			join(consumed, `${createHash("sha256").update(resolve(run)).digest("hex")}.json`),
			"备用事实另存",
		);
		let writes = 0;
		await withNormalRvfCloseoutMutation(repo.repositoryPath, run, async () => {
			writes++;
		});
		await withNormalRvfCloseoutMutation(repo.repositoryPath, `${run}-new`, async () => {
			writes++;
		});
		expect(writes).toBe(1);
	});

	it("异常结果保留 reservation 供重启后对账", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		await expect(
			withNormalRvfCloseoutMutation(repo.repositoryPath, null, async () => {
				throw new Error("response unknown");
			}),
		).rejects.toThrow("response unknown");
		const reservations = join(repo.repositoryPath, ".git", "rvf-independent-backup-route", "normal-mutations");
		const [name] = await readdir(reservations);
		expect(JSON.parse(await readFile(join(reservations, name), "utf8")).outcome).toBe("unknown");
	});
	it("抑制观察写入失败也不遗留未开始业务的 reservation", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		const control = join(repo.repositoryPath, ".git", "rvf-independent-backup-route");
		await mkdir(join(control, "active-owner"), { recursive: true });
		await expect(
			withNormalRvfCloseoutMutation(
				repo.repositoryPath,
				null,
				async () => {
					throw new Error("不得开始正常收尾");
				},
				async () => {
					throw new Error("观察登记不可用");
				},
			),
		).rejects.toThrow("观察登记不可用");
		expect(await readdir(join(control, "normal-mutations"))).toHaveLength(0);
	});

	it("linked worktree 的 Git 文件与原 run 路径别名绑定同一接管事实", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "repository" });
		await writeFile(join(repo.repositoryPath, "source.txt"), "合成夹具\n");
		repo.commitAllRepositoryFilesAtDate({
			message: "初始化隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const task = repo.createLinkedWorktree({ worktreeDirectoryName: "task", branchName: "task" });
		const gitDirectory = repo
			.runGit(["rev-parse", "--absolute-git-dir"], { workingDirectoryPath: task.worktreePath })
			.stdout.trim();
		const control = join(gitDirectory, "rvf-independent-backup-route");
		const run = join(fixture.fixtureRootDirectoryPath, "original-run");
		const alias = join(fixture.fixtureRootDirectoryPath, "original-run-alias");
		await mkdir(run);
		await symlink(run, alias);
		await mkdir(join(control, "consumed-original-runs"), { recursive: true });
		await writeFile(
			join(
				control,
				"consumed-original-runs",
				`${createHash("sha256")
					.update(await realpath(run))
					.digest("hex")}.json`,
			),
			"合成消费记录",
		);
		let writes = 0;
		await withNormalRvfCloseoutMutation(task.worktreePath, alias, async () => {
			writes++;
		});
		expect(writes).toBe(0);
		expect(await readdir(join(control, "normal-mutations"))).toHaveLength(0);
	});
});
