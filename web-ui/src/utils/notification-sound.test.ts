import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionUserTurnKind } from "@/runtime/types";
import { type NotificationSoundTier, resolveNotificationSoundTier } from "./notification-sound";

// 三档镜像 board-card-session-activity.ts 的 SESSION_ACTIVITY_COLOR 语义分组：
// error=红→"error" / question·plan_review·permission·needs_input=金→"attention" / review·默认=绿→"complete"。
// 与标题措辞表（细分到具体 kind）解耦：声音只分三档，凭音色可辨「完成 vs 需要你 vs 出错」。
describe("resolveNotificationSoundTier", () => {
	it("error → error 档（红）", () => {
		expect(resolveNotificationSoundTier("error")).toBe("error");
	});

	it.each<RuntimeTaskSessionUserTurnKind>(["needs_input", "question", "plan_review", "permission"])(
		"%s → attention 档（金：阻塞等你）",
		(kind) => {
			expect(resolveNotificationSoundTier(kind)).toBe("attention");
		},
	);

	it.each<RuntimeTaskSessionUserTurnKind>(["review", "interrupted"])(
		"%s → complete 档（绿：完成待审，默认）",
		(kind) => {
			expect(resolveNotificationSoundTier(kind)).toBe("complete");
		},
	);

	it("undefined / null（旧 payload 无字段 / turnOwner 非 user）→ complete 默认档", () => {
		expect(resolveNotificationSoundTier(undefined)).toBe("complete");
		expect(resolveNotificationSoundTier(null)).toBe("complete");
	});

	it("每个可通知 kind 都解析到三档之一（穷尽性守卫）", () => {
		const allowedTiers: NotificationSoundTier[] = ["complete", "attention", "error"];
		const notifiableKinds: RuntimeTaskSessionUserTurnKind[] = [
			"review",
			"needs_input",
			"question",
			"plan_review",
			"permission",
			"error",
			"interrupted",
		];
		for (const kind of notifiableKinds) {
			expect(allowedTiers).toContain(resolveNotificationSoundTier(kind));
		}
	});
});
