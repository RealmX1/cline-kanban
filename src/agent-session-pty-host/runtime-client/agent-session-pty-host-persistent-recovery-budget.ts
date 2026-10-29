import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type AgentSessionPtyHostRecoveryProgress,
	agentSessionPtyHostRecoveryProgressSchema,
} from "../../core/agent-session-pty-host-diagnostics-contract";
import { lockedFileSystem } from "../../fs/locked-file-system";

// EXPERIMENT_NODE: 同一故障最多三次、每次最多八秒、总计三十秒；间隔一秒和三秒，耗尽后每三十秒只读探测。
export const AGENT_SESSION_PTY_HOST_RECOVERY_MAXIMUM_ATTEMPTS = 3;
export const AGENT_SESSION_PTY_HOST_RECOVERY_TOTAL_BUDGET_MS = 30_000;
export const AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS = 30_000;
const MAXIMUM_SINGLE_ATTEMPT_BUDGET_MS = 8_000;
const RETRY_DELAYS_MS = [1_000, 3_000];

interface PersistentRecoveryBudgetOptions {
	recoveryStateFilePath: string;
	readEvidenceFingerprint: () => string;
	onProgress: (progress: AgentSessionPtyHostRecoveryProgress) => void;
	readNowEpochMs?: () => number;
	shouldContinueRecovery?: () => boolean;
	waitBeforeRetry?: (milliseconds: number) => Promise<void>;
	isFailureWithUnknownHostedSessionOwnership?: (error: unknown) => boolean;
}

export class AgentSessionPtyHostPersistentRecoveryBudget {
	private readonly readNow: () => number;
	private constructor(
		private readonly options: PersistentRecoveryBudgetOptions,
		private currentProgress: AgentSessionPtyHostRecoveryProgress | null,
	) {
		this.readNow = options.readNowEpochMs ?? Date.now;
	}

	static async load(options: PersistentRecoveryBudgetOptions): Promise<AgentSessionPtyHostPersistentRecoveryBudget> {
		let progress: AgentSessionPtyHostRecoveryProgress | null = null;
		try {
			progress = agentSessionPtyHostRecoveryProgressSchema.parse(
				JSON.parse(await readFile(options.recoveryStateFilePath, "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return new AgentSessionPtyHostPersistentRecoveryBudget(options, progress);
	}

	get progress(): AgentSessionPtyHostRecoveryProgress | null {
		return this.currentProgress;
	}

	async recover<T>(
		attempt: (attemptDeadlineAtEpochMs: number) => Promise<T>,
		probeWhetherHostRespondsWithoutLaunchingOrTakingController: () => Promise<boolean>,
	): Promise<{ kind: "ready"; value: T } | { kind: "budget_exhausted"; failureMessage: string }> {
		const fingerprint = this.options.readEvidenceFingerprint();
		let progress = this.currentProgress;
		if (!progress || progress.recoveryEvidenceFingerprint !== fingerprint || progress.recoveryCondition === "ready") {
			progress = this.beginNewBudget(fingerprint);
		}
		if (progress.recoveryCondition === "host_response_or_evidence_change") {
			if (this.readNow() < (progress.nextCheckAtEpochMs ?? 0)) return this.exhaustedOutcome(progress);
			progress.nextCheckAtEpochMs = this.readNow() + AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS;
			await this.persist(progress);
			if (!(await probeWhetherHostRespondsWithoutLaunchingOrTakingController()))
				return this.exhaustedOutcome(progress);
			progress = this.beginNewBudget(fingerprint);
		}
		while (
			progress.attemptsStarted < AGENT_SESSION_PTY_HOST_RECOVERY_MAXIMUM_ATTEMPTS &&
			this.readNow() < progress.retryBudgetExpiresAtEpochMs &&
			this.options.shouldContinueRecovery?.() !== false
		) {
			if (progress.nextCheckAtEpochMs !== null && this.readNow() < progress.nextCheckAtEpochMs) {
				await (
					this.options.waitBeforeRetry ??
					((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
				)(
					Math.min(
						progress.nextCheckAtEpochMs - this.readNow(),
						progress.retryBudgetExpiresAtEpochMs - this.readNow(),
					),
				);
			}
			if (
				this.readNow() >= progress.retryBudgetExpiresAtEpochMs ||
				this.options.shouldContinueRecovery?.() === false
			)
				break;
			progress.attemptsStarted += 1;
			progress.nextCheckAtEpochMs = null;
			// 先持久化消费预算，崩溃不能白得一次启动机会。
			await this.persist(progress);
			try {
				const value = await attempt(
					Math.min(progress.retryBudgetExpiresAtEpochMs, this.readNow() + MAXIMUM_SINGLE_ATTEMPT_BUDGET_MS),
				);
				progress.recoveryCondition = "ready";
				progress.lastFailureMessage = null;
				progress.lastFailureMayHideHostedSessions = false;
				await this.persist(progress);
				return { kind: "ready", value };
			} catch (error) {
				progress.lastFailureMessage = error instanceof Error ? error.message : String(error);
				progress.lastFailureMayHideHostedSessions =
					this.options.isFailureWithUnknownHostedSessionOwnership?.(error) ?? false;
				progress.nextCheckAtEpochMs = this.readNow() + (RETRY_DELAYS_MS[progress.attemptsStarted - 1] ?? 0);
				await this.persist(progress);
			}
		}
		if (this.options.shouldContinueRecovery?.() === false) return this.exhaustedOutcome(progress);
		progress.recoveryCondition = "host_response_or_evidence_change";
		progress.nextCheckAtEpochMs = this.readNow() + AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS;
		await this.persist(progress);
		return this.exhaustedOutcome(progress);
	}

	private beginNewBudget(fingerprint: string): AgentSessionPtyHostRecoveryProgress {
		return {
			schemaVersion: 1,
			recoveryEvidenceFingerprint: fingerprint,
			attemptsStarted: 0,
			retryBudgetStartedAtEpochMs: this.readNow(),
			retryBudgetExpiresAtEpochMs: this.readNow() + AGENT_SESSION_PTY_HOST_RECOVERY_TOTAL_BUDGET_MS,
			nextCheckAtEpochMs: null,
			recoveryCondition: "retry_budget_remaining",
			lastFailureMessage: null,
			lastFailureMayHideHostedSessions: false,
		};
	}

	private exhaustedOutcome(progress: AgentSessionPtyHostRecoveryProgress): {
		kind: "budget_exhausted";
		failureMessage: string;
	} {
		return { kind: "budget_exhausted", failureMessage: progress.lastFailureMessage ?? "PTY host 就绪预算已耗尽" };
	}

	private async persist(progress: AgentSessionPtyHostRecoveryProgress): Promise<void> {
		await mkdir(dirname(this.options.recoveryStateFilePath), { recursive: true });
		const history = await open(
			`${this.options.recoveryStateFilePath.replace(/\.json$/u, "")}-progress-history.jsonl`,
			"a",
			0o600,
		);
		try {
			await history.write(`${JSON.stringify({ recordedAtEpochMs: this.readNow(), ...progress })}\n`);
			await history.sync();
		} finally {
			await history.close();
		}
		await lockedFileSystem.writeJsonFileAtomic(this.options.recoveryStateFilePath, progress, {
			lock: null,
			durable: true,
			fileMode: 0o600,
		});
		this.currentProgress = progress;
		this.options.onProgress({ ...progress });
	}
}
