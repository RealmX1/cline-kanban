import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionUserTurnKind } from "@/runtime/types";
import { resolveReviewReadyNotificationTitle } from "./use-review-ready-notifications";

// ③(b)：通知标题随「人轴」userTurnKind 措辞，且 kind 取自一次性 ready 事件 payload（非延迟 summary 流）。
// 本套件只锁纯标题解析（事件→标题映射）；端到端「事件确实自带正确 kind」由
// runtime-state-stream.integration.test.ts 的 hook 转审用例钉住，二者合证竞态修复。
describe("resolveReviewReadyNotificationTitle", () => {
	describe("带 workspaceTitle 时拼出「<工程> <措辞>」", () => {
		it("review → ready for review（主路径）", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "review")).toBe("my-repo ready for review");
		});

		it("needs_input → needs your input", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "needs_input")).toBe("my-repo needs your input");
		});

		it("error → encountered an error", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "error")).toBe("my-repo encountered an error");
		});

		// Stage 4 采集增强：question / plan_review / permission 三类「阻塞等你」各有专属措辞。
		it("question → needs your answer", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "question")).toBe("my-repo needs your answer");
		});

		it("plan_review → has a plan to review", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "plan_review")).toBe("my-repo has a plan to review");
		});

		it("permission → needs permission", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", "permission")).toBe("my-repo needs permission");
		});
	});

	describe("无 workspaceTitle 时首字母大写、退化为通用标题", () => {
		it("review → Ready for review（保持旧默认标题逐字不变）", () => {
			expect(resolveReviewReadyNotificationTitle(null, "review")).toBe("Ready for review");
		});

		it("needs_input → Needs your input", () => {
			expect(resolveReviewReadyNotificationTitle(null, "needs_input")).toBe("Needs your input");
		});

		it("error → Encountered an error", () => {
			expect(resolveReviewReadyNotificationTitle(null, "error")).toBe("Encountered an error");
		});
	});

	describe("缺省/无专属措辞种类落到 review 措辞兜底", () => {
		it("undefined（旧服务端/缓存旧构建不带 payload 字段）→ ready for review", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", undefined)).toBe("my-repo ready for review");
			expect(resolveReviewReadyNotificationTitle(null, undefined)).toBe("Ready for review");
		});

		it("null（turnOwner 非 user 时的 facet 值）→ ready for review", () => {
			expect(resolveReviewReadyNotificationTitle("my-repo", null)).toBe("my-repo ready for review");
		});

		// review（主路径）与 interrupted（被中断，不在通知白名单但防御性映射）均无专属措辞 → 兜底。
		it.each<RuntimeTaskSessionUserTurnKind>(["review", "interrupted"])(
			"无专属措辞种类 %s → ready for review",
			(kind) => {
				expect(resolveReviewReadyNotificationTitle("my-repo", kind)).toBe("my-repo ready for review");
			},
		);
	});
});
