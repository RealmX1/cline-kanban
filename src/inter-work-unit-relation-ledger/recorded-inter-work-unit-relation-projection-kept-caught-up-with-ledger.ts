import type { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "./inter-work-unit-relation-ledger-database-worker-client";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import {
	applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection,
	clearRetroactiveRebuildRequirementOfRecordedInterWorkUnitRelationProjectionAfterDiagnosticWarning,
	collectTaskAgentSessionInitializationFieldValueSha256sReferencedByLedgerEvents,
	createEmptyRecordedInterWorkUnitRelationProjectionState,
	createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex,
	isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact,
	type RecordedInterWorkUnitRelationProjectionState,
} from "./recorded-inter-work-unit-relation-projection-from-ledger-events";

// dd2db 1b：runtime 进程内持有的记录型关系投影。不落盘、不建物化表：每次读之前按全局提交序号游标增量追上账本，
// 1a 的写路径一行不动，投影表改版也只需重启（内存状态从头重放）。
// EXPERIMENT_NODE: 读时增量投影 vs 写时物化投影表——账本事件量涨到每次冷启动全量重放明显拖慢首读时再评估物化。
const LEDGER_EVENT_PAGE_SIZE_FOR_PROJECTION_CATCH_UP = 5000;

// 追赶只用到账本客户端的这两个读能力（单测可用最小 fake 实现）。
export type InterWorkUnitRelationLedgerReadCapabilitiesUsedByRecordedRelationProjectionCatchUp = Pick<
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	"listCommittedEvents" | "readRetainedFieldContents"
>;

export interface RecordedInterWorkUnitRelationProjectionReader {
	readonly projectionState: RecordedInterWorkUnitRelationProjectionState;
	// 字段正文（标题、prompt……）按指纹读取；账本里没有的（images 不留正文）返回 null。
	readRetainedTaskCardFieldValuesBySha256(fieldValueSha256s: string[]): Promise<Map<string, unknown>>;
}

export class RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger {
	// 迟到的激活播种推翻先前归属判断时整体换成从头重放出的新状态（见 catchUpAllCommittedEventsAfterCursor）。
	private projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
	private readonly retainedFieldValueCanonicalJsonBySha256 = new Map<string, string>();
	private inFlightCatchUp: Promise<void> | null = null;

	constructor(
		private readonly ledgerClient: InterWorkUnitRelationLedgerReadCapabilitiesUsedByRecordedRelationProjectionCatchUp,
	) {}

	// 单飞：并发的读共用同一次追赶（含其中可能发生的从头重放）；追赶期间新提交的事件由下一次读补上。
	private async catchUpWithLedger(): Promise<void> {
		if (!this.inFlightCatchUp) {
			this.inFlightCatchUp = this.catchUpAllCommittedEventsAfterCursor().finally(() => {
				this.inFlightCatchUp = null;
			});
		}
		await this.inFlightCatchUp;
	}

	// 先把现有状态追到账本末尾（期间预扫描登记下全部播种事实）；若有迟到的激活播种推翻了先前的归属判断，
	// 再用继承播种事实索引的新状态从全局序号 0 重放一遍，重放完成后才换上。每次追赶最多重建一次。
	private async catchUpAllCommittedEventsAfterCursor(): Promise<void> {
		await this.applyAllCommittedEventsAfterCursorOfProjectionState(this.projectionState);
		if (
			!isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				this.projectionState,
			)
		) {
			return;
		}
		const rebuiltProjectionState =
			createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
				this.projectionState,
			);
		await this.applyAllCommittedEventsAfterCursorOfProjectionState(rebuiltProjectionState);
		if (
			isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				rebuiltProjectionState,
			)
		) {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`recorded relation projection still contradicted by a late live-capture-activation seeded fact after one retroactive rebuild (through global committed event sequence ${rebuiltProjectionState.lastAppliedGlobalCommittedEventSequence}); conversation session ownership / provenance may stay imprecise until the next rebuild`,
			);
			clearRetroactiveRebuildRequirementOfRecordedInterWorkUnitRelationProjectionAfterDiagnosticWarning(
				rebuiltProjectionState,
			);
		}
		this.projectionState = rebuiltProjectionState;
	}

	private async applyAllCommittedEventsAfterCursorOfProjectionState(
		projectionState: RecordedInterWorkUnitRelationProjectionState,
	): Promise<void> {
		for (;;) {
			const events = await this.ledgerClient.listCommittedEvents({
				afterGlobalCommittedEventSequence: projectionState.lastAppliedGlobalCommittedEventSequence,
				limit: LEDGER_EVENT_PAGE_SIZE_FOR_PROJECTION_CATCH_UP,
			});
			if (events.length === 0) {
				return;
			}
			await this.prefetchRetainedFieldValues(
				collectTaskAgentSessionInitializationFieldValueSha256sReferencedByLedgerEvents(events),
			);
			applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
				projectionState,
				events,
				(sha256) => this.retainedFieldValueCanonicalJsonBySha256.get(sha256) ?? null,
			);
			if (events.length < LEDGER_EVENT_PAGE_SIZE_FOR_PROJECTION_CATCH_UP) {
				return;
			}
		}
	}

	// 正文按指纹不可变，取过一次就常驻缓存。
	private async prefetchRetainedFieldValues(fieldValueSha256s: string[]): Promise<void> {
		const missingFieldValueSha256s = fieldValueSha256s.filter(
			(sha256) => !this.retainedFieldValueCanonicalJsonBySha256.has(sha256),
		);
		if (missingFieldValueSha256s.length === 0) {
			return;
		}
		for (const content of await this.ledgerClient.readRetainedFieldContents(missingFieldValueSha256s)) {
			this.retainedFieldValueCanonicalJsonBySha256.set(content.fieldValueSha256, content.fieldValueCanonicalJson);
		}
	}

	async readCaughtUpProjection<T>(
		read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
	): Promise<T> {
		await this.catchUpWithLedger();
		return await read({
			projectionState: this.projectionState,
			readRetainedTaskCardFieldValuesBySha256: async (fieldValueSha256s) => {
				await this.prefetchRetainedFieldValues(fieldValueSha256s);
				const fieldValuesBySha256 = new Map<string, unknown>();
				for (const sha256 of fieldValueSha256s) {
					const canonicalJson = this.retainedFieldValueCanonicalJsonBySha256.get(sha256);
					if (canonicalJson === undefined) {
						continue;
					}
					try {
						fieldValuesBySha256.set(sha256, JSON.parse(canonicalJson));
					} catch {
						// 正文损坏只影响展示：跳过，调用方按缺失处理。
					}
				}
				return fieldValuesBySha256;
			},
		});
	}
}
