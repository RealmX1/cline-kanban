import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { quoteShellArg } from "../src/core/shell";
import {
	renderAppendSystemPrompt,
	renderTaskCollaborationSessionResponsibilityGuidance,
	renderTaskSessionWorktreeGuardPrompt,
} from "../src/prompts/append-system-prompt";

// 固定实施前提交；只读重放同一输入，不将长度目标变成门禁。
const baselineCommit = "fefa08730f487aa32798f5bb694d3b99ef2f36cb";
function compileHistoricalPromptModule(path: string): string {
	let source = execFileSync("git", ["show", `${baselineCommit}:${path}`], { encoding: "utf8" });
	const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const imports = parsed.statements.filter(ts.isImportDeclaration);
	for (const declaration of imports.reverse())
		source = source.slice(0, declaration.getFullStart()) + source.slice(declaration.end);
	source = source.replace(/\bexport\s+/gu, "");
	return ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
}
const historicalModules = [
	"src/core/task-initial-prompt-authoring-and-startup-settings-guidance.ts",
	"src/core/task-naming-conventions.ts",
	"src/prompts/append-system-prompt.ts",
]
	.map(compileHistoricalPromptModule)
	.join("\n");
const taskId = "a289f",
	cwd = "/workspace/task",
	commandPrefix = "kanban";
const baseline = runInNewContext(
	`${historicalModules}\n({task:renderTaskSessionWorktreeGuardPrompt(taskId,cwd,commandPrefix),sidebar:renderAppendSystemPrompt(commandPrefix,{agentId:"codex"}),collaboration:renderTaskSessionWorktreeGuardPrompt(taskId,cwd,commandPrefix)+"\\n\\n"+renderTaskCollaborationSessionResponsibilityGuidance(taskId,"collaborator")})`,
	{ packageJson: { version: "0.1.68" }, quoteShellArg, taskId, cwd, commandPrefix },
) as Record<string, string>;
const current = {
	task: renderTaskSessionWorktreeGuardPrompt(taskId, cwd, commandPrefix),
	sidebar: renderAppendSystemPrompt(commandPrefix, { agentId: "codex" }),
	collaboration: `${renderTaskSessionWorktreeGuardPrompt(taskId, cwd, commandPrefix)}\n\n${renderTaskCollaborationSessionResponsibilityGuidance(taskId, "collaborator")}`,
};
function measure(text: string) {
	return { unicodeCharacters: [...text].length, utf8Bytes: Buffer.byteLength(text, "utf8") };
}
process.stdout.write(
	`${JSON.stringify(
		{
			baselineCommit,
			sample: {
				taskId,
				cwd,
				commandPrefix,
				scope: "角色流程说明；不含用户需求、动态关系邻域、AGENTS.md 或模型提供方指令",
			},
			planReportedBaselineCharacters: { task: 8895, sidebar: 16045, collaboration: 9071 },
			roles: Object.fromEntries(
				Object.entries(current).map(([role, prompt]) => {
					const before = measure(baseline[role]);
					const after = measure(prompt);
					return [
						role,
						{
							before,
							after,
							unicodeCharacterReductionPercent: Number(
								((1 - after.unicodeCharacters / before.unicodeCharacters) * 100).toFixed(2),
							),
							utf8ByteReductionPercent: Number(((1 - after.utf8Bytes / before.utf8Bytes) * 100).toFixed(2)),
						},
					];
				}),
			),
		},
		null,
		2,
	)}\n`,
);
