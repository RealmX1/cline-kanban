import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NotificationLifecycleArchive } from "../../src/notifications/notification-lifecycle-archive";

describe("通知永久档案", () => {
	it("旧档案重开后音频恢复按事件类型查索引，并保留去重与已完成过滤", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-notification-recovery-index-test-"));
		const archive = new NotificationLifecycleArchive(directory);
		try {
			for (const candidateId of ["pending-audio", "completed-audio", "without-audio-intent"]) {
				await archive.capture({
					candidateId,
					workspaceId: "workspace-a",
					taskId: candidateId,
					triggeredAt: 1,
					userTurnKind: "review",
					sourceKind: "test",
				});
			}
			await archive.update("pending-audio", {}, "speech_audio_persistence_started", {});
			await archive.update("pending-audio", {}, "speech_audio_persistence_started", {});
			await archive.update(
				"completed-audio",
				{ audioSha256: "a".repeat(64) },
				"speech_audio_persistence_started",
				{},
			);
			await archive.close();
			const legacyDatabase = new Database(join(directory, "notification-lifecycle.sqlite"));
			try {
				// 模拟升级前只有 candidate_id 索引的永久档案。
				legacyDatabase.exec("DROP INDEX IF EXISTS notification_lifecycle_events_event_type_candidate");
			} finally {
				legacyDatabase.close();
			}
			expect(await archive.pendingAudioPersistenceCandidates()).toEqual(["pending-audio"]);
			const database = new Database(join(directory, "notification-lifecycle.sqlite"), { readonly: true });
			try {
				const plan = database
					.prepare<[], { detail: string }>(
						"EXPLAIN QUERY PLAN SELECT DISTINCT e.candidate_id FROM notification_lifecycle_events e JOIN notification_candidates c ON c.candidate_id=e.candidate_id WHERE e.event_type='speech_audio_persistence_started' AND json_extract(c.candidate_json,'$.audioSha256') IS NULL",
					)
					.all()
					.map((row) => row.detail);
				expect(plan.some((detail) => /SEARCH e USING COVERING INDEX .* \(event_type=\?\)/u.test(detail))).toBe(
					true,
				);
				expect(plan.some((detail) => detail.startsWith("SCAN e"))).toBe(false);
			} finally {
				database.close();
			}
		} finally {
			await archive.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("超过 300 条不淘汰；清空只改变可见性，历史和并发新增均保留", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-notification-archive-test-"));
		const archive = new NotificationLifecycleArchive(directory);
		try {
			await Promise.all(
				Array.from({ length: 310 }, (_, index) =>
					archive.capture({
						candidateId: `candidate-${index}`,
						workspaceId: "workspace-a",
						taskId: "task-a",
						triggeredAt: index,
						userTurnKind: "review",
						sourceKind: "test",
						rawPayload: { index },
					}),
				),
			);
			await archive.update("candidate-0", { notificationPanelVisibility: "visible" }, "panel_admitted", {});
			await archive.clearPanel("workspace-a");
			await archive.update("candidate-1", { notificationPanelVisibility: "visible" }, "panel_admitted", {});
			expect((await archive.list({ limit: 50 })).totalCount).toBe(310);
			expect((await archive.get("candidate-0"))?.candidate.notificationPanelVisibility).toBe("cleared");
			expect((await archive.get("candidate-0"))?.events.map((event) => event.eventType)).toEqual([
				"candidate_captured",
				"panel_admitted",
				"panel_cleared",
			]);
			expect((await archive.list({ panelOnly: true })).entries.map((entry) => entry.candidateId)).toEqual([
				"candidate-1",
			]);
			await archive.capture({
				candidateId: "candidate-0",
				workspaceId: "workspace-a",
				taskId: "task-a",
				triggeredAt: 0,
				userTurnKind: "review",
				sourceKind: "test",
			});
			expect((await archive.list({})).totalCount).toBe(310);
		} finally {
			await archive.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("十万条档案按页读取，全量未读操作不受 50 条显示上限影响", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-notification-volume-test-"));
		const archive = new NotificationLifecycleArchive(directory);
		try {
			await archive.importLegacy(
				"volume-fixture",
				Array.from({ length: 100_000 }, (_, index) => ({
					candidateId: `volume-${index}`,
					workspaceId: "volume",
					taskId: `task-${index % 101}`,
					triggeredAt: index,
					userTurnKind: "review",
					sourceKind: "test",
					notificationPanelVisibility: "visible" as const,
				})),
			);
			const started = performance.now();
			const page = await archive.panelGroups({ limit: 50 });
			expect(page.entries).toHaveLength(50);
			expect(page.unreadTaskCount).toBe(101);
			expect(performance.now() - started).toBeLessThan(5_000);
			await archive.markAllVisited(false);
			expect((await archive.panelGroups()).unreadTaskCount).toBe(0);
			await archive.clearAllPanels();
			expect((await archive.list({ limit: 50 })).totalCount).toBe(100_000);
			expect((await archive.panelGroups()).entries).toHaveLength(0);
		} finally {
			await archive.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it("多个连接原子领取；重启后保存延期和投递状态", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-notification-archive-test-"));
		const first = new NotificationLifecycleArchive(directory);
		const second = new NotificationLifecycleArchive(directory);
		try {
			await first.capture({
				candidateId: "one",
				workspaceId: "workspace-a",
				taskId: "task-a",
				triggeredAt: Date.now(),
				userTurnKind: "review",
				sourceKind: "test",
			});
			await first.update(
				"one",
				{ notificationPanelVisibility: "visible", deferredNotificationFallbackDeadlineAt: 123 },
				"panel_admitted",
				{},
			);
			const claims = await Promise.all([
				first.claimDelivery("one", "browser-a"),
				second.claimDelivery("one", "browser-b"),
			]);
			expect(claims.filter(Boolean)).toHaveLength(1);
			await first.close();
			expect((await second.get("one"))?.candidate.deferredNotificationFallbackDeadlineAt).toBe(123);
		} finally {
			await first.close();
			await second.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
