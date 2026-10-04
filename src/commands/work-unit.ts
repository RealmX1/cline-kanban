import type { Command } from "commander";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	parseWorkUnitReferenceCommandLineArgument,
	resolveWorkUnitSelectorOfInvokingProcessEnvironment,
	WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION,
} from "../core/work-unit-reference-command-line-argument";
import type { WorkUnitSelectorForRelationRead } from "../core/work-unit-relation-read-api-contract";
import { createRuntimeTrpcClient, printJson } from "./task";

// dd2db 1b：`kanban work-unit` 的读动词（R3.4）。关系账本只在 runtime 内打开，所以全部经 runtime procedure；
// runtime 离线或账本不可用时如实失败，绝不打印空邻域冒充「没有关系」。
// 写动词（接手、参照、门……）从阶段 2 起加入同一命名空间。

function resolveSubjectWorkUnitSelector(
	workUnitReferenceArgument: string | undefined,
): WorkUnitSelectorForRelationRead {
	if (workUnitReferenceArgument !== undefined) {
		return parseWorkUnitReferenceCommandLineArgument(workUnitReferenceArgument);
	}
	const selectorOfInvokingProcess = resolveWorkUnitSelectorOfInvokingProcessEnvironment(process.env);
	if (!selectorOfInvokingProcess) {
		throw new Error(
			`This process is neither a Kanban task session nor a recognizable agent session; pass the work unit explicitly (${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}).`,
		);
	}
	return selectorOfInvokingProcess;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

async function runWorkUnitReadCommand(handler: () => Promise<{ text: string } | { json: unknown }>): Promise<void> {
	try {
		const output = await handler();
		if ("text" in output) {
			process.stdout.write(`${output.text}\n`);
		} else {
			printJson(output.json);
		}
	} catch (error) {
		printJson({
			ok: false,
			error: `Work unit command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerWorkUnitCommand(program: Command): void {
	const workUnit = program
		.command("work-unit")
		.description(
			"Read relations between Kanban work units (task cards and standalone agent sessions). The subject defaults to the invoking session.",
		);

	workUnit
		.command("get-relation-neighborhood-summary")
		.description(
			"Show who created, forked, adopted, dispatched or amended this work unit, and which work units it acted on (recorded relations).",
		)
		.option(
			"--work-unit <ref>",
			`Subject work unit: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.option("--depth <depth>", "1 = direct neighbors (default); 2 = also the neighbors' own relations.", "1")
		.option("--json", "Print the full structured neighborhood instead of the text summary.")
		.action(async (options: { workUnit?: string; depth: string; json?: boolean }) => {
			await runWorkUnitReadCommand(async () => {
				if (options.depth !== "1" && options.depth !== "2") {
					throw new Error(`Unsupported --depth "${options.depth}"; use 1 or 2.`);
				}
				const response = await createRuntimeTrpcClient(null).workUnit.getRelationNeighborhoodSummary.query({
					workUnit: resolveSubjectWorkUnitSelector(options.workUnit),
					relationNeighborhoodDepth: options.depth === "2" ? 2 : 1,
				});
				return options.json
					? { json: { ok: true, ...response } }
					: { text: response.renderedNeighborhoodSummaryText };
			});
		});

	workUnit
		.command("get-work-unit-context")
		.description("Read the context of a work unit. Only global-recap is available in this phase.")
		.option(
			"--work-unit <ref>",
			`Subject work unit: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.requiredOption("--context-level <level>", "Context level: global-recap.")
		.option("--json", "Print the structured response, including completeness and provider availability.")
		.action(async (options: { workUnit?: string; contextLevel: string; json?: boolean }) => {
			await runWorkUnitReadCommand(async () => {
				if (options.contextLevel !== "global-recap") {
					throw new Error(
						`Unsupported --context-level "${options.contextLevel}"; only global-recap is available until full-intent-dossier and transcript-excerpt land.`,
					);
				}
				const response = await createRuntimeTrpcClient(null).workUnit.getWorkUnitContext.query({
					workUnit: resolveSubjectWorkUnitSelector(options.workUnit),
					workUnitContextLevel: "global_recap",
				});
				if (options.json || response.globalRecapText === null) {
					return { json: { ok: response.workUnitContextProviderAvailability === "available", ...response } };
				}
				return { text: response.globalRecapText };
			});
		});

	workUnit
		.command("list-conversation-session-ownership-periods")
		.description("List which native agent conversation sessions belonged to a work unit, and when.")
		.option(
			"--of-work-unit <ref>",
			`Work unit whose sessions to list: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.action(async (options: { ofWorkUnit?: string }) => {
			await runWorkUnitReadCommand(async () => ({
				json: {
					ok: true,
					...(await createRuntimeTrpcClient(null).workUnit.listConversationSessionOwnershipPeriods.query({
						workUnit: resolveSubjectWorkUnitSelector(options.ofWorkUnit),
					})),
				},
			}));
		});
}
