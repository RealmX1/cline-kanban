import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionUserTurnKind } from "@/runtime/types";
import {
	resolveReviewReadyNotificationBody,
	resolveReviewReadyNotificationTitle,
} from "./use-review-ready-notifications";

// 标题随「人轴」userTurnKind 措辞，kind 取自一次性 ready 事件 payload（非延迟 summary 流）。
// 双轴重构后标题 = 措辞本身（首字母大写、独立成句），不再前缀项目名——项目名/任务标题改放正文前两行。
// 端到端「事件确实自带正确 kind」由 runtime-state-stream.integration.test.ts 的 hook 转审用例钉住。
describe("resolveReviewReadyNotificationTitle", () => {
	it("review → Ready for review（主路径，保持旧默认标题逐字不变）", () => {
		expect(resolveReviewReadyNotificationTitle("review")).toBe("Ready for review");
	});

	it("needs_input → Needs your input", () => {
		expect(resolveReviewReadyNotificationTitle("needs_input")).toBe("Needs your input");
	});

	it("error → Encountered an error", () => {
		expect(resolveReviewReadyNotificationTitle("error")).toBe("Encountered an error");
	});

	// Stage 4 采集增强：question / plan_review / permission 三类「阻塞等你」各有专属措辞。
	it("question → Needs your answer", () => {
		expect(resolveReviewReadyNotificationTitle("question")).toBe("Needs your answer");
	});

	it("plan_review → Has a plan to review", () => {
		expect(resolveReviewReadyNotificationTitle("plan_review")).toBe("Has a plan to review");
	});

	it("permission → Needs permission", () => {
		expect(resolveReviewReadyNotificationTitle("permission")).toBe("Needs permission");
	});

	describe("缺省/无专属措辞种类落到 review 措辞兜底", () => {
		it("undefined（旧服务端/缓存旧构建不带 payload 字段）→ Ready for review", () => {
			expect(resolveReviewReadyNotificationTitle(undefined)).toBe("Ready for review");
		});

		it("null（turnOwner 非 user 时的 facet 值）→ Ready for review", () => {
			expect(resolveReviewReadyNotificationTitle(null)).toBe("Ready for review");
		});

		// review（主路径）与 interrupted（被中断，不在通知白名单但防御性映射）均无专属措辞 → 兜底。
		it.each<RuntimeTaskSessionUserTurnKind>(["review", "interrupted"])(
			"无专属措辞种类 %s → Ready for review",
			(kind) => {
				expect(resolveReviewReadyNotificationTitle(kind)).toBe("Ready for review");
			},
		);
	});
});

// 正文多行：第 1 行 repo / 工作区目录名、第 2 行任务标题、第 3 行 agent 最终消息（若有）。缺省行被过滤。
describe("resolveReviewReadyNotificationBody", () => {
	it("三行齐全：repo / 任务标题 / finalMessage 依次成行", () => {
		expect(resolveReviewReadyNotificationBody("my-repo", "Fix the login bug", "Done — all tests green")).toBe(
			"my-repo\nFix the login bug\nDone — all tests green",
		);
	});

	it("无 finalMessage（null）→ 仅 repo + 任务标题两行", () => {
		expect(resolveReviewReadyNotificationBody("my-repo", "Fix the login bug", null)).toBe(
			"my-repo\nFix the login bug",
		);
	});

	it("无 finalMessage（undefined）→ 仅 repo + 任务标题两行", () => {
		expect(resolveReviewReadyNotificationBody("my-repo", "Fix the login bug", undefined)).toBe(
			"my-repo\nFix the login bug",
		);
	});

	it("无 workspace（null）→ 任务标题打头", () => {
		expect(resolveReviewReadyNotificationBody(null, "Fix the login bug", "Done")).toBe("Fix the login bug\nDone");
	});

	it("空白 finalMessage 被丢弃（仅空格/换行）", () => {
		expect(resolveReviewReadyNotificationBody("my-repo", "Fix the login bug", "   \n  ")).toBe(
			"my-repo\nFix the login bug",
		);
	});

	it("空白 workspace 被丢弃，任务标题打头", () => {
		expect(resolveReviewReadyNotificationBody("   ", "Fix the login bug", "Done")).toBe("Fix the login bug\nDone");
	});

	it("仅任务标题（workspace 与 finalMessage 均缺）→ 单行", () => {
		expect(resolveReviewReadyNotificationBody(null, "Fix the login bug", null)).toBe("Fix the login bug");
	});
});
