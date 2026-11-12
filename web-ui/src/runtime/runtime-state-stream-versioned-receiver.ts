import {
	runtimeStateStreamVersionedDeltaMessageSchema,
	runtimeStateStreamVersionedSnapshotMessageSchema,
} from "@runtime-contract";
import { applyRuntimeStateEntityUpdate } from "@runtime-state-stream-entity-synchronization";
import type {
	RuntimeStateStreamClientMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamSnapshotMessage,
} from "@/runtime/types";

export class RuntimeStateStreamVersionedReceiver {
	private baseline: RuntimeStateStreamSnapshotMessage | null = null;
	private hasReceivedLegacySnapshot = false;
	private runtimeGenerationId: string | null = null;
	private sequenceNumber = 0;
	private recoveryAttemptCount = 0;
	private recoverySourceFingerprint: string | null = null;
	private recoveryPending = false;
	private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly send: (message: RuntimeStateStreamClientMessage) => void,
		private readonly reportError: (message: string) => void,
	) {}

	get hasVersionedBaseline(): boolean {
		return this.runtimeGenerationId !== null;
	}

	confirmVersion(): void {
		if (this.runtimeGenerationId)
			this.send({
				type: "confirm_state_version_v2",
				runtimeGenerationId: this.runtimeGenerationId,
				sequenceNumber: this.sequenceNumber,
			});
	}

	dispose(): void {
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = null;
	}

	recoverMissingInitialSnapshot(): void {
		if (!this.baseline && !this.hasReceivedLegacySnapshot)
			this.recover(this.recoverySourceFingerprint ?? "initial_snapshot_missing");
	}

	private recover(fingerprint: string): void {
		if (this.recoverySourceFingerprint !== fingerprint) {
			this.recoveryAttemptCount = 0;
			this.recoverySourceFingerprint = fingerprint;
		}
		if (this.recoveryPending) return;
		if (this.recoveryAttemptCount >= 3) return;
		this.recoveryPending = true;
		this.recoveryAttemptCount += 1;
		this.reportError(`状态同步缺少完整基线，正在自动恢复（${this.recoveryAttemptCount}/3）`);
		this.send({ type: "request_state_snapshot_v2" });
		this.recoveryTimer = setTimeout(() => {
			this.recoveryPending = false;
			if (this.recoveryAttemptCount < 3) this.recover(this.recoverySourceFingerprint ?? fingerprint);
			else this.reportError("状态同步恢复暂未成功，已保留现有内容；连接、源版本或订阅范围变化后自动重试");
		}, 5000);
	}

	resumeRecoveryAfterScopeChange(): void {
		if (this.recoverySourceFingerprint) {
			this.dispose();
			this.recoveryPending = false;
			this.recoveryAttemptCount = 0;
			this.recover(this.recoverySourceFingerprint);
		}
	}

	receive(message: RuntimeStateStreamMessage): RuntimeStateStreamMessage | null {
		if (message.type === "snapshot") {
			this.hasReceivedLegacySnapshot = true;
			this.dispose();
			this.recoveryPending = false;
			this.recoverySourceFingerprint = null;
			return message;
		}
		if (message.type === "state_snapshot_v2") {
			const parsed = runtimeStateStreamVersionedSnapshotMessageSchema.safeParse(message);
			if (!parsed.success) {
				this.recover(`${message.runtimeGenerationId}:${message.sequenceNumber}`);
				return null;
			}
			message = parsed.data;
			if (
				message.workspaceId !== message.snapshot.currentProjectId ||
				!Number.isSafeInteger(message.sequenceNumber)
			) {
				this.recover(`${message.runtimeGenerationId}:${message.sequenceNumber}`);
				return null;
			}
			if (
				this.runtimeGenerationId === message.runtimeGenerationId &&
				message.sequenceNumber <= this.sequenceNumber &&
				!this.recoverySourceFingerprint
			)
				return null;
			this.dispose();
			this.recoveryPending = false;
			this.recoveryAttemptCount = 0;
			this.recoverySourceFingerprint = null;
			this.runtimeGenerationId = message.runtimeGenerationId;
			this.sequenceNumber = message.sequenceNumber;
			this.baseline = message.snapshot;
			return message.snapshot;
		}
		if (message.type === "state_version_v2") {
			if (
				message.runtimeGenerationId !== this.runtimeGenerationId ||
				message.sequenceNumber !== this.sequenceNumber ||
				message.workspaceId !== this.baseline?.currentProjectId
			)
				this.recover(`${message.runtimeGenerationId}:${message.sequenceNumber}`);
			return null;
		}
		if (message.type !== "state_delta_v2") return message;
		const fingerprint = `${message.runtimeGenerationId}:${message.sequenceNumber}`;
		const parsed = runtimeStateStreamVersionedDeltaMessageSchema.safeParse(message);
		if (!parsed.success) {
			this.recover(fingerprint);
			return null;
		}
		message = parsed.data;
		if (
			!this.baseline ||
			this.runtimeGenerationId !== message.runtimeGenerationId ||
			message.workspaceId !== this.baseline.currentProjectId ||
			message.previousSequenceNumber !== this.sequenceNumber ||
			message.sequenceNumber !== this.sequenceNumber + 1 ||
			this.recoverySourceFingerprint
		) {
			this.recover(fingerprint);
			return null;
		}
		try {
			const next = applyRuntimeStateEntityUpdate(this.baseline, message.update);
			this.baseline = next;
			this.sequenceNumber = message.sequenceNumber;
			const update = message.update;
			if (update.type === "projects_patch")
				return { type: "projects_updated", currentProjectId: next.currentProjectId, projects: next.projects };
			if (update.type === "metadata_patch")
				return {
					type: "workspace_metadata_updated",
					workspaceId: update.workspaceId,
					workspaceMetadata: next.workspaceMetadata!,
				};
			if (update.type === "sessions_patch")
				return {
					type: "task_sessions_updated",
					workspaceId: update.workspaceId,
					summaries: update.sessions.upserts,
				};
			return {
				type: "workspace_state_updated",
				workspaceId: update.workspaceId,
				workspaceState: next.workspaceState!,
			};
		} catch {
			this.recover(fingerprint);
			return null;
		}
	}
}
