import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

type AdoptionQueryKind = "overview" | "details";

interface AdoptionQueryHistoryWorkMeasurement {
	scenario: string;
	historyCount: number;
	queryKind: AdoptionQueryKind;
	virtualMachineInstructions: number;
	rows: Record<string, string | number | null>[];
}

export interface CodexConfigurationAdoptionQueryHistoryWorkReport {
	sqliteVersion: string;
	progressHandlerInstructionInterval: number;
	diagnosticBytesPerTarget: number;
	measurements: AdoptionQueryHistoryWorkMeasurement[];
	comparisons: {
		scenario: string;
		queryKind: AdoptionQueryKind;
		smallHistoryInstructions: number;
		largeHistoryInstructions: number;
		maximumLargeHistoryInstructions: number;
	}[];
	failures: string[];
}

function extractWorkerSourceFragment(workerSource: string, startMarker: string, endMarker: string): string {
	const start = workerSource.indexOf(startMarker);
	const end = workerSource.indexOf(endMarker, start);
	if (start < 0 || end <= start) throw new Error(`无法提取生产 SQL：${startMarker} → ${endMarker}`);
	return workerSource.slice(start, end);
}

export function assertCodexConfigurationAdoptionQueryHistoryWorkIsBounded(
	workerSource = readFileSync(
		new URL("../../src/codex-configuration-sync/codex-configuration-sync-database-worker.mjs", import.meta.url),
		"utf8",
	),
): CodexConfigurationAdoptionQueryHistoryWorkReport {
	const schemaStatements: string[] = [];
	runInNewContext(extractWorkerSourceFragment(workerSource, "const collectionTables =", "const reader ="), {
		existingStorageMetadata: undefined,
		database: {
			exec: (sql: string) => schemaStatements.push(sql),
			pragma: () => 1,
			transaction: (operation: () => void) => ({ immediate: operation }),
		},
	});
	const queries: { queryKind: AdoptionQueryKind; sql: string; parameters: string[] }[] = [];
	const session = {
		workspaceId: "query-history-workspace",
		conversationSessionId: "query-history-session",
		runtimeSessionIncarnationId: "query-history-incarnation",
		writerId: "query-history-current-writer",
		profileId: "query-history-profile",
	};
	for (const queryKind of ["overview", "details"] as const) {
		// 执行生产函数生成完整 SQL，避免测试副本遗漏历史扫描谓词。
		runInNewContext(
			`${extractWorkerSourceFragment(workerSource, "function sessionAdoptionRows(", "function readOverview(")}\n` +
				"sessionAdoptionRows({ sessions: [session] }, connection, aggregate);",
			{
				session,
				aggregate: queryKind === "overview",
				connection: {
					prepare: (sql: string) => ({
						all: (...parameters: string[]) => {
							queries.push({ queryKind, sql, parameters });
							return [];
						},
					}),
				},
			},
		);
	}
	if (queries.length !== 2) throw new Error(`生产函数应生成两种查询，实际生成 ${queries.length} 种。`);
	const measurementProcess = spawnSync(
		"python3",
		["-I", "-B", fileURLToPath(new URL("./codex-configuration-adoption-query-history-work.py", import.meta.url))],
		{
			input: JSON.stringify({ schemaStatements, queries, session }),
			encoding: "utf8",
			timeout: 60_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONUTF8: "1" },
		},
	);
	if (measurementProcess.error || measurementProcess.status !== 0) {
		throw new Error(
			`配置采用查询工作量回归失败：${measurementProcess.error?.message ?? measurementProcess.status}\n` +
				`${measurementProcess.stdout}\n${measurementProcess.stderr}`,
		);
	}
	return JSON.parse(measurementProcess.stdout) as CodexConfigurationAdoptionQueryHistoryWorkReport;
}
