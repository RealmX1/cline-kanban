import { randomUUID } from "node:crypto";
import type { CodexConfigurationSyncService } from "../../src/codex-configuration-sync/codex-configuration-sync-service";
import type { CodexConfigurationSyncState } from "../../src/core/codex-configuration-sync-contract";

// 既有传播回归测试从“用户已审批”的边界开始；审批前行为由专门的审批测试覆盖。
export function withExplicitApprovalOfObservedCodexConfigurationProposals(
	service: CodexConfigurationSyncService,
): CodexConfigurationSyncService {
	const readState = service.getState;
	const approveNonConflictingProposals = async (state: CodexConfigurationSyncState) => {
		const proposals = state.changes.filter(
			(change) => change.approvalStatus === "pending" && change.mergeStatus === "pending_approval",
		);
		if (!proposals.length) return state;
		const result = await service.batchAction({
			action: "approve",
			items: proposals.map((change) => ({
				entryKind: "settings_proposal",
				changeId: change.changeId,
				expectedVersion: change.version,
				idempotencyKey: randomUUID(),
			})),
		});
		return result.state;
	};
	return {
		...service,
		getState: async () => approveNonConflictingProposals(await readState()),
		scan: async () => {
			await service.scan();
			await approveNonConflictingProposals(await readState());
		},
	};
}
