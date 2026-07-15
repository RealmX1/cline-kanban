import { describe, expect, it } from "vitest";

import type { RuntimePostDeployVerificationTask } from "@/runtime/types";
import { resolvePostDeployVerificationStuckDoneRecovery } from "./post-deploy-verification-completion-recovery";

const NOW_MS = Date.parse("2026-07-05T12:00:00.000Z");

function makeTask(overrides: Partial<RuntimePostDeployVerificationTask> = {}): RuntimePostDeployVerificationTask {
	return {
		taskId: "task-1",
		columnIdAtMatch: "review",
		matchedCommits: [],
		inclusionReason: "commit_correlation",
		checklist: [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: {
			token: "tok-1",
			expiresAtIso: "2026-07-05T12:10:00.000Z", // NOW + 10min：未过期
			// 默认走 validation-origin（空 acks）：这是唯一可自动恢复的安全滞留态（免确认框、无可伪造的 acknowledgement）。
			requiredAcknowledgements: [],
			columnIdAtIssuance: "validation",
		},
		droppedReason: null,
		...overrides,
	};
}

describe("resolvePostDeployVerificationStuckDoneRecovery", () => {
	it("returns the pending token when stuck in Done with a valid unexpired empty-acks (validation-origin) token", () => {
		expect(resolvePostDeployVerificationStuckDoneRecovery(makeTask(), "trash", NOW_MS)?.token).toBe("tok-1");
	});

	it("returns null when the task is not in the Done (trash) column", () => {
		expect(resolvePostDeployVerificationStuckDoneRecovery(makeTask(), "review", NOW_MS)).toBeNull();
		expect(resolvePostDeployVerificationStuckDoneRecovery(makeTask(), null, NOW_MS)).toBeNull();
	});

	it("returns null when the task is already verified (nothing to recover)", () => {
		expect(
			resolvePostDeployVerificationStuckDoneRecovery(
				makeTask({ verifiedAt: "2026-07-05T11:59:00.000Z" }),
				"trash",
				NOW_MS,
			),
		).toBeNull();
	});

	it("returns null when the task has been dropped by reconcile", () => {
		expect(
			resolvePostDeployVerificationStuckDoneRecovery(
				makeTask({ droppedReason: "moved_out_manually" }),
				"trash",
				NOW_MS,
			),
		).toBeNull();
	});

	it("returns null when there is no pending confirmation (token already reclaimed)", () => {
		expect(
			resolvePostDeployVerificationStuckDoneRecovery(makeTask({ pendingConfirmation: null }), "trash", NOW_MS),
		).toBeNull();
	});

	it("returns null when the pending token has expired", () => {
		// 用空 acks 保持「唯一致 null 的因素是过期」，避免被非空-acks 守卫提前短路而失去对过期判定的区分度。
		const task = makeTask({
			pendingConfirmation: {
				token: "tok-1",
				expiresAtIso: "2026-07-05T11:59:00.000Z", // NOW - 1min：已过期
				requiredAcknowledgements: [],
				columnIdAtIssuance: "validation",
			},
		});
		expect(resolvePostDeployVerificationStuckDoneRecovery(task, "trash", NOW_MS)).toBeNull();
	});

	it("returns null when the pending token carries non-empty acknowledgements (review/in_progress origin — must not auto-confirm)", () => {
		// review 发放的 skip_validation token 残留（可能来自取消对话框 + 手动移列）：绝不自动确认，以免伪造安全二次确认。
		const reviewTask = makeTask({
			pendingConfirmation: {
				token: "tok-1",
				expiresAtIso: "2026-07-05T12:10:00.000Z", // 未过期
				requiredAcknowledgements: ["skip_validation"],
				columnIdAtIssuance: "review",
			},
		});
		expect(resolvePostDeployVerificationStuckDoneRecovery(reviewTask, "trash", NOW_MS)).toBeNull();
		// in_progress 发放的双 acks token 同理。
		const inProgressTask = makeTask({
			pendingConfirmation: {
				token: "tok-2",
				expiresAtIso: "2026-07-05T12:10:00.000Z",
				requiredAcknowledgements: ["skip_validation", "in_progress_active"],
				columnIdAtIssuance: "in_progress",
			},
		});
		expect(resolvePostDeployVerificationStuckDoneRecovery(inProgressTask, "trash", NOW_MS)).toBeNull();
	});

	it("returns null for a null task", () => {
		expect(resolvePostDeployVerificationStuckDoneRecovery(null, "trash", NOW_MS)).toBeNull();
	});
});
