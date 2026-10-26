import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectNativeHistoryMainSessionHandoverMaterial } from "../../../src/agent-session-history/native-history-main-session-handover-material";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { TaskMainSessionHandoverReportAcceptanceProbe } from "../../../src/core/task-main-session-handover-contract";
import {
	queryCursorMainSessionHandoverAcceptedHumanFollowup,
	queryTaskMainSessionHandoverReportAcceptance,
} from "../../../src/server/task-main-session-handover-report-acceptance";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const managedKimiHome = vi.hoisted(() => vi.fn<() => string>());
vi.mock("../../../src/terminal/kimi-hook-config", () => ({ getKanbanManagedKimiCodeHome: managedKimiHome }));
afterEach(() => vi.unstubAllEnvs());

it.each(["cursor", "kimi"] as const)(
	"%s 从精确原生归属读取材料及完整报告，截断与其他会话不能充当接受",
	async (agentId) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		try {
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CURSOR_CONFIG_DIR", join(fixture.isolatedHomeDirectoryPath, ".cursor"));
			vi.stubEnv("CURSOR_DATA_DIR", join(fixture.isolatedHomeDirectoryPath, ".cursor"));
			const cwd = await realpath(fixture.ownedIntegrationProjectsDirectoryPath);
			const nativeId = "22222222-2222-4222-8222-222222222222";
			const card = {
				id: "task",
				title: "原生交接",
				prompt: "保留主线要求",
				baseRef: "main",
				startInPlanMode: false,
				createdAt: 1,
				updatedAt: 1,
			};
			let transcriptPath: string;
			if (agentId === "cursor") {
				const chatPath = join(
					fixture.isolatedHomeDirectoryPath,
					".cursor",
					"chats",
					createHash("md5").update(cwd).digest("hex"),
					nativeId,
				);
				await mkdir(chatPath, { recursive: true });
				await writeFile(
					join(chatPath, "meta.json"),
					JSON.stringify({ hasConversation: true, isSubagent: false, cwd }),
				);
				// 检查器不能打开原始 sqlite；故意使用非 sqlite 内容，只有读取导出转录才可能通过。
				await writeFile(join(chatPath, "store.db"), "原始存储禁止打开或改写");
				const slug = cwd
					.replace(/[^a-zA-Z0-9]/gu, "-")
					.replace(/-+/gu, "-")
					.replace(/^-+|-+$/gu, "");
				transcriptPath = join(
					fixture.isolatedHomeDirectoryPath,
					".cursor",
					"projects",
					slug,
					"agent-transcripts",
					nativeId,
					`${nativeId}.jsonl`,
				);
				await mkdir(join(transcriptPath, ".."), { recursive: true });
			} else {
				const home = join(fixture.isolatedHomeDirectoryPath, "managed-kimi");
				managedKimiHome.mockReturnValue(home);
				const directory = join(home, "sessions", "cwd-bucket", nativeId);
				await mkdir(join(directory, "agents", "main"), { recursive: true });
				await writeFile(join(directory, "state.json"), JSON.stringify({ version: 2, id: nativeId, cwd }));
				await writeFile(
					join(home, "session_index.jsonl"),
					`${JSON.stringify({ sessionId: nativeId, sessionDir: directory, workDir: cwd })}\n`,
				);
				transcriptPath = join(directory, "agents", "main", "wire.jsonl");
			}
			const summary = runtimeTaskSessionSummarySchema.parse({
				taskId: card.id,
				agentId,
				workspacePath: cwd,
				runtimeSessionIncarnationId: "incarnation",
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				turnOwner: null,
				liveness: "none",
				userTurnKind: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: agentId,
					nativeSessionId: nativeId,
					transcriptPath: null,
					observedAt: 1,
				},
			});
			const prompt = "KANBAN_MAIN_SESSION_HANDOVER_REPORT:handover:report:0\n只读汇报后等待真人";
			const serialize = (userText: string, agent = "main") =>
				agentId === "cursor"
					? `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: userText }] } })}\n${JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "前任最后正文" }] } })}\n`
					: `${JSON.stringify({ type: "metadata", protocol_version: "1.5" })}\n${JSON.stringify({
							type: "context.append_message",
							agentId: agent,
							time: 10,
							message: {
								id: "prompt",
								role: "user",
								origin: { kind: "user" },
								content: [
									{ type: "text", text: userText },
									{ type: "text", text: "hook 注入内容", meta: { source: "user prompt submit hook" } },
								],
							},
						})}\n${JSON.stringify({ type: "context.append_message", agentId: agent, time: 20, message: { id: "answer", role: "assistant", content: [{ type: "text", text: "前任最后正文" }] } })}\n`;
			const probe = {
				targetAgentId: agentId,
				nativeSessionId: nativeId,
				workingDirectoryPath: cwd,
				transcriptPath: null,
				nativeHistoryCursor: null,
				transcriptHistoryCursor: null,
				seenNativeHistoryCursors: [],
				historicalAcceptanceEvidence: null,
			};
			await writeFile(transcriptPath, serialize(prompt.slice(0, -3)));
			expect(
				(
					await queryTaskMainSessionHandoverReportAcceptance({
						workspaceId: "project",
						summary,
						card,
						probe,
						prompt,
					})
				).historicalAcceptanceEvidence,
			).toBeNull();
			await writeFile(
				transcriptPath,
				Array.from({ length: 160 }, (_, index) => serialize(`旧消息 ${index}`)).join(""),
			);
			const paginated = await queryTaskMainSessionHandoverReportAcceptance({
				workspaceId: "project",
				summary,
				card,
				probe,
				prompt,
			});
			expect(paginated.transcriptHistoryCursor).not.toBeNull();
			expect(paginated.historicalAcceptanceEvidence).toBeNull();
			await appendFile(transcriptPath, serialize(prompt));
			let restored = JSON.parse(JSON.stringify(paginated)) as TaskMainSessionHandoverReportAcceptanceProbe;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				restored = await queryTaskMainSessionHandoverReportAcceptance({
					workspaceId: "project",
					summary,
					card,
					probe: restored,
					prompt,
				});
				restored = JSON.parse(JSON.stringify(restored)) as TaskMainSessionHandoverReportAcceptanceProbe;
			}
			expect(restored.historicalAcceptanceEvidence).not.toBeNull();
			await writeFile(transcriptPath, serialize(prompt));
			const accepted = await queryTaskMainSessionHandoverReportAcceptance({
				workspaceId: "project",
				summary,
				card,
				probe,
				prompt,
			});
			expect(accepted.historicalAcceptanceEvidence).not.toBeNull();
			expect(accepted.transcriptPath).toBe(await realpath(transcriptPath));
			const material = await collectNativeHistoryMainSessionHandoverMaterial({
				card,
				sourceSummary: summary,
				workspacePath: cwd,
			});
			expect(material.lastAgentMessage?.text).toBe("前任最后正文");
			expect(material.transcriptReferences).toEqual([await realpath(transcriptPath)]);
			assert(summary.agentNativeConversationSessionIdentity);
			const foreign = {
				...summary,
				agentNativeConversationSessionIdentity: {
					...summary.agentNativeConversationSessionIdentity,
					nativeSessionId: "different-session",
				},
			};
			const rejected = await queryTaskMainSessionHandoverReportAcceptance({
				workspaceId: "project",
				summary: foreign,
				card,
				probe: { ...probe, nativeSessionId: "different-session" },
				prompt,
			});
			expect(rejected.historicalAcceptanceEvidence).toBeNull();
			if (agentId === "kimi") {
				await writeFile(transcriptPath, serialize(prompt, "subagent"));
				expect(
					(
						await queryTaskMainSessionHandoverReportAcceptance({
							workspaceId: "project",
							summary,
							card,
							probe,
							prompt,
						})
					).historicalAcceptanceEvidence,
				).toBeNull();
			} else {
				expect(await queryCursorMainSessionHandoverAcceptedHumanFollowup({ card, summary })).toBeNull();
				await writeFile(
					transcriptPath,
					serialize(prompt) +
						`${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "现在继续主线" }] } })}\n`,
				);
				expect(await queryCursorMainSessionHandoverAcceptedHumanFollowup({ card, summary })).toBe("现在继续主线");
				const chatPath = join(
					fixture.isolatedHomeDirectoryPath,
					".cursor",
					"chats",
					createHash("md5").update(cwd).digest("hex"),
					nativeId,
				);
				expect(await readFile(join(chatPath, "store.db"), "utf8")).toBe("原始存储禁止打开或改写");
			}
		} finally {
			fixture.cleanup();
		}
	},
);
