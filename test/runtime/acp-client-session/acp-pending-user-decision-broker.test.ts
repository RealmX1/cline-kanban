// 「agent 等用户拍板」通道。最要紧的一条是：**每个 pending 决策最终都必须被 resolve**——
// ACP 里这是请求-响应，不回的话 agent 侧会一直挂着（规范明确要求 cancel 后回 cancelled）。
import { describe, expect, it, vi } from "vitest";

import {
	AcpPendingUserDecisionBroker,
	type AcpPendingUserDecisionPresentation,
} from "../../../src/acp-client-session/acp-pending-user-decision-broker";
import type {
	AcpCreateElicitationRequest,
	AcpRequestPermissionRequest,
} from "../../../src/acp-client-session/acp-protocol-boundary";

function createBroker() {
	const presented: AcpPendingUserDecisionPresentation[] = [];
	const settled = vi.fn();
	const broker = new AcpPendingUserDecisionBroker({
		presentDecision: (presentation) => presented.push(presentation),
		settleDecision: settled,
	});
	return { broker, presented, settled };
}

const PERMISSION_REQUEST: AcpRequestPermissionRequest = {
	sessionId: "session-1",
	toolCall: { toolCallId: "call-1", title: "$ rm -rf build" },
	options: [
		{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
		{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	],
};

const PLAN_ELICITATION_REQUEST = {
	mode: "form",
	message: "Approve this plan?",
	requestedSchema: {
		type: "object",
		properties: {
			choice: { type: "string", enum: ["approve", "refine"], enumNames: ["Approve and execute", "Refine plan"] },
		},
	},
} as unknown as AcpCreateElicitationRequest;

describe("AcpPendingUserDecisionBroker", () => {
	it("presents a permission request and resolves with the option the user picked", async () => {
		const { broker, presented } = createBroker();
		const pending = broker.requestToolPermission("task-1", PERMISSION_REQUEST);

		expect(presented).toHaveLength(1);
		expect(presented[0].decision.kind).toBe("tool_permission");
		expect(presented[0].decision.options.map((option) => option.label)).toEqual(["Allow once", "Reject"]);
		expect(presented[0].promptMarkdown).toContain("$ rm -rf build");

		broker.resolvePendingDecision("task-1", presented[0].decision.decisionId, {
			outcome: "selected",
			optionId: "allow_once",
		});

		await expect(pending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
	});

	// 铁律：cancel 之后所有 pending 授权都必须收到 cancelled，否则 agent 永远挂着。
	it("resolves every pending decision with cancelled when the task is cancelled", async () => {
		const { broker, presented, settled } = createBroker();
		const firstPending = broker.requestToolPermission("task-1", PERMISSION_REQUEST);
		const secondPending = broker.requestToolPermission("task-1", PERMISSION_REQUEST);
		expect(presented).toHaveLength(2);

		broker.cancelPendingDecisions("task-1");

		await expect(firstPending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
		await expect(secondPending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
		expect(settled).toHaveBeenCalledTimes(2);
	});

	it("leaves other tasks' pending decisions untouched when one task is cancelled", async () => {
		const { broker, presented } = createBroker();
		const otherTaskPending = broker.requestToolPermission("task-2", PERMISSION_REQUEST);
		broker.cancelPendingDecisions("task-1");

		// task-2 仍在等待：给它一个决定，promise 才落地。
		const otherDecisionId = presented[0].decision.decisionId;
		expect(
			broker.resolvePendingDecision("task-2", otherDecisionId, { outcome: "selected", optionId: "allow_once" }),
		).toBe(true);
		await expect(otherTaskPending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
	});

	it("rejects a second resolution for the same decision", () => {
		const { broker, presented } = createBroker();
		void broker.requestToolPermission("task-1", PERMISSION_REQUEST);
		const decisionId = presented[0].decision.decisionId;
		expect(broker.resolvePendingDecision("task-1", decisionId, { outcome: "selected", optionId: "allow_once" })).toBe(
			true,
		);
		expect(broker.resolvePendingDecision("task-1", decisionId, { outcome: "selected", optionId: "allow_once" })).toBe(
			false,
		);
	});

	it("turns a form elicitation's enum choices into decision options and accepts the pick", async () => {
		const { broker, presented } = createBroker();
		const pending = broker.requestElicitation("task-1", PLAN_ELICITATION_REQUEST);

		expect(presented[0].decision.kind).toBe("elicitation_form");
		expect(presented[0].decision.options.map((option) => option.label)).toEqual([
			"Approve and execute",
			"Refine plan",
		]);

		broker.resolvePendingDecision("task-1", presented[0].decision.decisionId, {
			outcome: "selected",
			optionId: "choice:approve",
		});

		await expect(pending).resolves.toEqual({ action: "accept", content: { choice: "approve" } });
	});

	// 未支持的 elicitation 形态要明确回绝，而不是假装接受——后者会让 agent 以为用户同意了。
	it("declines elicitation shapes it cannot render instead of silently accepting", async () => {
		const { broker, presented } = createBroker();
		const response = await broker.requestElicitation("task-1", {
			mode: "url",
			message: "Open this link",
		} as unknown as AcpCreateElicitationRequest);
		expect(response).toEqual({ action: "decline" });
		expect(presented).toHaveLength(0);
	});
});
