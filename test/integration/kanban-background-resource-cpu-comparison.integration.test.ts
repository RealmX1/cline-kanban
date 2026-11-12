import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import { transform } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
	closeCodexConfigurationSyncDatabase,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncActiveStore,
	readCodexConfigurationSyncLookupStore,
	readCodexConfigurationSyncStorageMetrics,
} from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { readCodexConfigurationTargetSnapshot } from "../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { createTempDir } from "../utilities/temp-dir";

const evidenceDirectory = process.env.KANBAN_BACKGROUND_RESOURCE_COMPARISON_EVIDENCE_DIRECTORY;
const baselineScannerSourcePath = process.env.KANBAN_BACKGROUND_RESOURCE_BASELINE_SCANNER_SOURCE_PATH;

describe("后台资源固定语料 CPU 对照", () => {
	it.skipIf(!evidenceDirectory || !baselineScannerSourcePath)(
		"五组 AB／BA 核对扫描快照等价与精确目标查询的规模独立性",
		async () => {
			if (!evidenceDirectory || !baselineScannerSourcePath) throw new Error("缺少持久证据目录或冻结基线源码");
			const fixture = createTempDir("background-resource-cpu-comparison-");
			vi.stubEnv("HOME", fixture.path);
			vi.stubEnv("CODEX_HOME", join(fixture.path, "isolated-codex-configuration"));
			vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-codex-storage"));
			const measurements: Record<string, unknown>[] = [];
			try {
				await mkdir(evidenceDirectory, { recursive: true });
				const baselineSource = await readFile(baselineScannerSourcePath, "utf8");
				const baselineFunction = baselineSource.slice(
					baselineSource.indexOf("export async function readCodexConfigurationTargetSnapshot("),
					baselineSource.indexOf("export function createCodexConfigurationTargetObservationMonitor("),
				);
				if (!baselineFunction.startsWith("export async function")) throw new Error("冻结基线未包含预期扫描函数");
				const transformed = await transform(baselineFunction, { loader: "ts", format: "cjs", target: "es2022" });
				const baselineModule = {
					exports: {} as { readCodexConfigurationTargetSnapshot: typeof readCodexConfigurationTargetSnapshot },
				};
				// 仅执行本仓冻结版本的同一个函数；文件系统依赖与当前实现完全相同。
				new Function(
					"module",
					"lstat",
					"open",
					"readlink",
					"readdir",
					"relative",
					"join",
					"digest",
					transformed.code,
				)(baselineModule, lstat, open, readlink, readdir, relative, join, (value: string | Buffer) =>
					createHash("sha256").update(value).digest("hex"),
				);
				const target = join(fixture.path, "fixed-plugin-corpus");
				await mkdir(target);
				await writeFile(join(target, "__proto__"), "");
				for (let offset = 0; offset < 4_001; offset += 100)
					await Promise.all(
						Array.from({ length: Math.min(100, 4_001 - offset) }, (_, index) =>
							writeFile(join(target, `plugin-${String(offset + index).padStart(5, "0")}`), ""),
						),
					);
				for (let pair = 0; pair < 5; pair++)
					for (const implementation of pair % 2 ? ["current", "baseline"] : ["baseline", "current"]) {
						const cpuStarted = process.cpuUsage();
						const wallStarted = performance.now();
						const snapshot = await (implementation === "current"
							? readCodexConfigurationTargetSnapshot
							: baselineModule.exports.readCodexConfigurationTargetSnapshot)(target);
						measurements.push({
							scenario: "plugin_snapshot",
							pair,
							implementation,
							wallDurationMs: performance.now() - wallStarted,
							cpuUsage: process.cpuUsage(cpuStarted),
							snapshotSha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
						});
					}
				expect(new Set(measurements.map((measurement) => measurement.snapshotSha256)).size).toBe(1);
				const sourceHome = process.env.CODEX_HOME;
				if (!sourceHome) throw new Error("缺少隔离配置路径");
				await mkdir(sourceHome);
				await writeFile(join(sourceHome, "config.toml"), 'model = "fixed-corpus-model"\n');
				const binding = await prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					storageHome: sourceHome,
					workspaceId: "isolated-resource-comparison",
					conversationSessionId: "effective-target",
					runtimeSessionIncarnationId: randomUUID(),
				});
				let previousTargetedDecodedBytes: number | undefined;
				for (const targetCount of [20, 200]) {
					await mutateCodexConfigurationSyncStore((store) => {
						store.changes = store.changes.filter((change) => !change.changeId.startsWith("pending-change-"));
						const original = store.writers[binding.writerId];
						const retiredWriterIds = Array.from(
							{ length: targetCount - 1 },
							(_, index) => `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
						);
						for (const writerId of retiredWriterIds)
							store.writers[writerId] = {
								...structuredClone(original),
								binding: { ...original.binding, writerId },
								retiredAt: 1,
								lastObservedFields: {
									...original.lastObservedFields,
									'["config.toml","synthetic_payload"]': { value: "x".repeat(32 * 1024) },
								},
							};
						store.changes.push({
							changeId: `pending-change-${targetCount}`,
							version: targetCount,
							sourceWriterId: binding.writerId,
							sourceIdentity: binding.sourceIdentity,
							fieldKey: '["config.toml","model"]',
							value: { value: "fixed-corpus-model" },
							observedAt: 1,
							recordKind: "settings_proposal",
							approvalStatus: "approved",
							mergeStatus: "shared_default_updated",
							acknowledgedAt: null,
							targets: [binding.writerId, ...retiredWriterIds].map((writerId) => ({
								writerId,
								workspaceId: "isolated-resource-comparison",
								conversationSessionId: "effective-target",
								status: "pending_next_start",
								reason: "固定合成目标",
								attemptCount: 0,
								acceptedAt: 1,
								diskSavedAt: null,
								ownerReloadedAt: null,
								recoveryCondition: null,
							})),
						});
					});
					for (let pair = 0; pair < 5; pair++)
						for (const implementation of pair % 2 ? ["lookup", "active"] : ["active", "lookup"]) {
							const before = (await readCodexConfigurationSyncStorageMetrics()).cumulative;
							const cpuStarted = process.cpuUsage();
							const wallStarted = performance.now();
							let serializedProjectionBytes = 0;
							for (let iteration = 0; iteration < 8; iteration++) {
								const store =
									implementation === "active"
										? await readCodexConfigurationSyncActiveStore()
										: await readCodexConfigurationSyncLookupStore({
												changeIds: [`pending-change-${targetCount}`],
												writerIds: [binding.writerId],
												targetWriterIds: [binding.writerId],
												includeActiveTargets: false,
											});
								serializedProjectionBytes += serialize(store).byteLength;
							}
							const cpuUsage = process.cpuUsage(cpuStarted);
							const wallDurationMs = performance.now() - wallStarted;
							const after = (await readCodexConfigurationSyncStorageMetrics()).cumulative;
							const decodedBytes = after.decodedBytes - before.decodedBytes;
							measurements.push({
								scenario: "configuration_projection_read_and_serialize",
								targetCount,
								pair,
								implementation,
								iterations: 8,
								wallDurationMs,
								cpuUsage,
								serializedProjectionBytes,
								decodedBytes,
								decodedRows: after.decodedRows - before.decodedRows,
							});
							if (implementation === "lookup") {
								if (previousTargetedDecodedBytes !== undefined)
									expect(decodedBytes).toBeLessThan(previousTargetedDecodedBytes + 4_096);
								previousTargetedDecodedBytes = decodedBytes;
							}
						}
				}
			} finally {
				await closeCodexConfigurationSyncDatabase();
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(
					join(evidenceDirectory, "fixed-corpus-cpu-comparison.json"),
					JSON.stringify(measurements, null, 2),
				);
				vi.unstubAllEnvs();
				fixture.cleanup();
			}
		},
		120_000,
	);
});
