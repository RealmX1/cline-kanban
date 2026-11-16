import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { runtimeProjectAddRequestSchema } from "../core/api-contract";
import { duplicateProjectConsolidationRequestSchema } from "../core/duplicate-project-consolidation-contract";
import { createRuntimeTrpcClient } from "./task";

async function runProjectCommand(run: () => Promise<unknown>) {
	try {
		const result = await run();
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (result && typeof result === "object" && "ok" in result && result.ok === false) process.exitCode = 1;
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
		process.exitCode = 1;
	}
}

export function registerProjectCommand(program: Command) {
	const project = program.command("project").description("显式预览、新增或合并已注册项目。");
	project
		.command("preview-consolidation")
		.requiredOption("--source-workspace-id <id>", "待移除的重复项目。")
		.requiredOption("--target-workspace-id <id>", "接收任务的正常项目。")
		.action(async (options: { sourceWorkspaceId: string; targetWorkspaceId: string }) =>
			runProjectCommand(() => createRuntimeTrpcClient(null).projects.previewDuplicateConsolidation.query(options)),
		);
	project
		.command("consolidate")
		.requiredOption("--request-file <path>", "包含来源、目标和 previewFingerprint 的 JSON；失败后复用同一请求接续。")
		.action(async (options: { requestFile: string }) =>
			runProjectCommand(async () =>
				createRuntimeTrpcClient(null).projects.consolidateDuplicate.mutate(
					duplicateProjectConsolidationRequestSchema.parse(
						JSON.parse(await readFile(options.requestFile, "utf8")),
					),
				),
			),
		);

	project
		.command("preview-add")
		.requiredOption("--path <path>", "已有 Git 仓库路径。")
		.action(async (options: { path: string }) =>
			runProjectCommand(() => createRuntimeTrpcClient(null).projects.previewAdd.query({ path: options.path })),
		);
	project
		.command("add")
		.requiredOption(
			"--request-file <path>",
			"含 path、previewFingerprint 及 authorization.userQuote/sourceReference 的 JSON。",
		)
		.action(async (options: { requestFile: string }) =>
			runProjectCommand(async () =>
				createRuntimeTrpcClient(null).projects.add.mutate(
					runtimeProjectAddRequestSchema.parse(JSON.parse(await readFile(options.requestFile, "utf8"))),
				),
			),
		);
}
