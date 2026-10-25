import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import { executeStatelessTaskIndexingAgent } from "../../src/task-indexing-support/stateless-task-indexing-agent-executor";
import { TASK_ANALYSIS_SHARED_CONTEXT_VERSION } from "../../src/task-indexing-support/task-analysis-shared-prompt-prefix";
import {
	loadAndAdvanceSharedTaskIndexingContext,
	readTaskIndexingSupportExecutorSettings,
	saveTaskIndexingSupportExecutorSettings,
	taskIndexingSupportWorkspaceStoragePath,
} from "../../src/task-indexing-support/task-indexing-support-storage";
import { analyzeTaskProjectAssignment } from "../../src/task-indexing-support/task-project-assignment-analysis";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("项目、召回与关系的单轮 CLI 分析", { timeout: 60000 }, () => {
	it("默认 Codex，兼容旧项目设置，全局保存后统一，并共用真实前缀字节", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "single-turn-project",
			initialBranchName: "main",
		});
		const scope = await loadWorkspaceContext(repository.repositoryPath);
		const executableDirectory = join(fixture.isolatedHomeDirectoryPath, "controlled-analysis-cli");
		await mkdir(executableDirectory, { recursive: true });
		const auditPath = join(executableDirectory, "model-calls.jsonl");
		await writeFile(
			join(executableDirectory, "codex"),
			`#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
const args=process.argv.slice(2);const setting=args.find(arg=>arg.startsWith('model_instructions_file='));const prefix=fs.readFileSync(JSON.parse(setting.slice(setting.indexOf('=')+1)),'utf8');
fs.appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({prefix,input,args})+'\\n');
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));const output=schema.properties.suggestedWorkspaceId?{suggestedWorkspaceId:null,rationale:'当前项目合适',confidence:'high'}:{accepted:true};
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');});`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", `${executableDirectory}:${process.env.PATH ?? ""}`);
		try {
			expect(await readTaskIndexingSupportExecutorSettings(scope.workspaceId)).toEqual({
				agentId: "codex",
				modelId: null,
			});
			const legacyPath = taskIndexingSupportWorkspaceStoragePath(scope.workspaceId, "executor-settings.json");
			await mkdir(join(legacyPath, ".."), { recursive: true });
			await writeFile(legacyPath, JSON.stringify({ agentId: "claude", modelId: "legacy-model" }));
			expect((await readTaskIndexingSupportExecutorSettings(scope.workspaceId)).agentId).toBe("claude");
			await saveTaskIndexingSupportExecutorSettings(null, { agentId: "codex", modelId: null });
			expect((await readTaskIndexingSupportExecutorSettings(scope.workspaceId)).agentId).toBe("codex");
			const analysis = await analyzeTaskProjectAssignment({
				workspaceId: scope.workspaceId,
				operationId: randomUUID(),
				title: "任务",
				prompt: "完整需求",
				settings: { agentId: "codex", modelId: null },
				materials: [],
			});
			const context = await loadAndAdvanceSharedTaskIndexingContext({
				workspaceId: scope.workspaceId,
				materials: [],
				settings: { agentId: "codex", modelId: null },
				instructionVersion: TASK_ANALYSIS_SHARED_CONTEXT_VERSION,
				now: Date.now(),
				forModelRequest: true,
			});
			for (const instructionText of ["查卡第一阶段召回", "关系建议"])
				await executeStatelessTaskIndexingAgent({
					settings: { agentId: "codex", modelId: null },
					context,
					instructionText,
					queryText: "本次任务",
					outputSchema: z.object({ accepted: z.boolean() }),
				});
			const calls: Array<{ prefix: string; input: string; args: string[] }> = (await readFile(auditPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(calls).toHaveLength(3);
			expect(new Set(calls.map((call) => call.prefix)).size).toBe(1);
			expect(analysis.suggestedWorkspaceId).toBeNull();
			expect(
				calls.every(
					(call) =>
						call.args.includes("--ephemeral") &&
						call.args.includes("features.shell_tool=false") &&
						call.args.includes("mcp_servers={}"),
				),
			).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
