import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

it.skipIf(process.env.KANBAN_RUN_ISOLATED_PROVENANCE_WRITE_BENCHMARK !== "1")(
	"隔离真实 git：稳定缓存和未提交变动的 provenance 实际写盘数",
	{ timeout: 120_000 },
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const evidence = process.env.KANBAN_LATENCY_BENCHMARK_EVIDENCE_DIRECTORY;
		const baseline = process.env.KANBAN_LATENCY_BENCHMARK_BASELINE_CHECKOUT;
		if (!evidence || !baseline) throw new Error("缺少持久目录或基线 checkout");
		const checkout = process.cwd();
		const requireFromCheckout = createRequire(join(checkout, "package.json"));
		const samples = [];
		for (const [variant, source] of [
			["baseline", baseline],
			["candidate", checkout],
		]) {
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: `provenance-${variant}` });
			writeFileSync(join(repository.repositoryPath, "tracked.txt"), "initial\n");
			const head = repository.commitAllRepositoryFilesAtDate({
				message: "初始化写盘夹具",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const { worktreePath } = repository.createLinkedWorktree({
				worktreeDirectoryName: `provenance-${variant}-worktree`,
				branchName: "task-provenance",
			});
			const parent = join(fixture.isolatedHomeDirectoryPath, ".cline/worktrees/provenance-target");
			mkdirSync(parent, { recursive: true });
			symlinkSync(worktreePath, join(parent, basename(repository.repositoryPath)));
			const script = join(fixture.fixtureRootDirectoryPath, `provenance-${variant}.mts`);
			writeFileSync(
				script,
				`
import {statSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {loadWorkspaceContext,getWorkspaceDirectoryPath} from ${JSON.stringify(join(source, "src/state/workspace-state.ts"))};
import {recordTaskWorktreeCreationCommitProvenance} from ${JSON.stringify(join(source, "src/workspace/task-commit-integration-provenance.ts"))};
import {loadTaskWorkspaceMetadata,createBaseRefTipResolver} from ${JSON.stringify(join(source, "src/workspace/task-worktree-git-metadata-probe.ts"))};
const repoPath=${JSON.stringify(repository.repositoryPath)};
const worktreePath=${JSON.stringify(worktreePath)};
const workspaceId=(await loadWorkspaceContext(repoPath)).workspaceId;
await recordTaskWorktreeCreationCommitProvenance({workspaceId,taskId:"provenance-target",baseRef:"main",initialBaseCommit:${JSON.stringify(head)}});
const path=join(getWorkspaceDirectoryPath(workspaceId),"task-commit-integration-provenance.json");
const task={taskId:"provenance-target",baseRef:"main"};
let current=await loadTaskWorkspaceMetadata(workspaceId,repoPath,task,null,createBaseRefTipResolver(repoPath));
if(!current?.data.exists || current.data.workspaceGitStatus.taskCommitIntegrationTrackingStatus!=="complete")throw new Error("无有效初始元数据: "+JSON.stringify(current));
const originalSnapshot=JSON.parse(readFileSync(path,"utf8")).tasks[task.taskId].lastWorkspaceGitSnapshot;
const results=[];
for(const scenario of ["stable-cache","dirty-working-tree"]){
 let writes=0; const durations=[];
 for(let index=0;index<20;index++){
  if(scenario==="dirty-working-tree") { writeFileSync(join(worktreePath,"tracked.txt"),"changed\\n".repeat(index+1)); current={...current,lastFullRefreshAtMs:0}; }
  const before=statSync(path,{bigint:true}).mtimeNs;
  const started=performance.now();
  current=await loadTaskWorkspaceMetadata(workspaceId,repoPath,task,current,createBaseRefTipResolver(repoPath));
  durations.push(performance.now()-started);
  if(statSync(path,{bigint:true}).mtimeNs!==before)writes++;
 }
 const snapshot=JSON.parse(readFileSync(path,"utf8")).tasks[task.taskId].lastWorkspaceGitSnapshot;
 if(JSON.stringify(snapshot)!==JSON.stringify(originalSnapshot))throw new Error("未提交变动不应改变 provenance 快照或时间戳");
 results.push({scenario,writes,samples:20,durations});
}
process.stdout.write(JSON.stringify(results));
`,
			);
			const environment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				KANBAN_RUNTIME_PORT: "39999",
			});
			const result = spawnSync(process.execPath, ["--import", requireFromCheckout.resolve("tsx"), script], {
				cwd: repository.repositoryPath,
				env: environment,
				encoding: "utf8",
				timeout: 100_000,
			});
			expect(result.status, result.stderr).toBe(0);
			const results = JSON.parse(result.stdout);
			expect(results[0].writes).toBe(0);
			expect(results[1].writes).toBe(0);
			samples.push({ variant, results });
		}
		writeFileSync(join(evidence, "provenance-write-samples.json"), JSON.stringify(samples, null, 2));
	},
);
