import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type QueuedTaskPromptDeliveryEntry,
	queuedTaskPromptDeliveryEntrySchema,
	runtimeTaskSessionSummarySchema,
	type WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/core/api-contract";
import type { CodexNativeConversationTurn } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { NativeIndependentUserTurnDeliveryError } from "../../../src/rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import { createNativeIndependentUserTurnBeforeSubmissionValidator } from "../../../src/server/native-independent-user-turn-before-submission-validator";
import {
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
} from "../../../src/state/queued-task-prompt-delivery-store";
import {
	applyCodexAutomaticCompactionPhaseObservation,
	createCodexRvfCloseoutCompactionAwareConfirmation,
	resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs,
} from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import {
	type CodexNativePromptDeliveryInput,
	deliverCodexNativePromptWithoutChangingComposer,
} from "../../../src/terminal/codex-native-prompt-delivery";

const mocks = vi.hoisted(() => ({
	request: vi.fn(),
	connect: vi.fn(),
	isolatedRuntimeHomePath: "",
	queryRecoveryClockEpochMs: 0,
}));
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: mocks.connect,
}));
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => mocks.isolatedRuntimeHomePath,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(mocks.isolatedRuntimeHomePath, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(mocks.isolatedRuntimeHomePath, "workspaces"),
}));
vi.mock("node:timers/promises", () => ({
	setTimeout: async (milliseconds: number) => {
		mocks.queryRecoveryClockEpochMs += milliseconds;
	},
}));

const CLIENT_MESSAGE_ID = "97fe98c3-7480-4689-884a-22c83a584f20";
const INCARNATION_ID = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
const PROMPT = "程序化投递\n中文😀  \n";

function createInput(overrides: Partial<CodexNativePromptDeliveryInput> = {}): CodexNativePromptDeliveryInput {
	let clock = 0;
	return {
		summary: runtimeTaskSessionSummarySchema.parse({
			taskId: "conversation-1",
			agentId: "codex",
			workspacePath: "/workspace",
			pid: 123,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			state: "awaiting_review",
			reviewReason: "hook",
			exitCode: null,
			runtimeSessionIncarnationId: INCARNATION_ID,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "thread-1",
				transcriptPath: null,
				observedAt: 1,
			},
			codexNativeSessionControlEndpoint: {
				socketPath: "/isolated/control.sock",
				workspaceId: "workspace-1",
				conversationSessionId: "conversation-1",
				runtimeSessionIncarnationId: INCARNATION_ID,
			},
		}),
		workspaceId: "workspace-1",
		text: PROMPT,
		clientUserMessageId: CLIENT_MESSAGE_ID,
		isCurrent: () => true,
		beforeSubmit: vi.fn(async () => true),
		onRequestAttempted: vi.fn(),
		now: () => clock,
		waitMilliseconds: async (milliseconds) => {
			clock += milliseconds;
		},
		...overrides,
	};
}

function installNativeResponses(
	options: {
		submitThrowsAfterAcceptance?: boolean;
		neverAccepted?: boolean;
		echoClientMessageId?: boolean;
		nativeMessageContent?: { type: string; text?: string }[];
	} = {},
) {
	let attempted = false;
	mocks.request.mockImplementation(async (method: string) => {
		if (method === "thread/loaded/list") return { data: ["thread-1"], nextCursor: null };
		if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace" } };
		if (method === "thread/turns/list") {
			return {
				data:
					attempted && !options.neverAccepted
						? [
								{
									id: "native-turn-2",
									status: "inProgress",
									items: [
										{
											id: options.echoClientMessageId ? CLIENT_MESSAGE_ID : "native-user-2",
											type: "userMessage",
											content: options.nativeMessageContent ?? [{ type: "text", text: PROMPT }],
										},
									],
								},
							]
						: [{ id: "prior-turn", status: "completed", items: [] }],
				nextCursor: null,
			};
		}
		if (method === "turn/start") {
			attempted = true;
			if (options.submitThrowsAfterAcceptance) throw new Error("模拟写出请求后断线");
			return { turn: { id: "native-turn-2" } };
		}
		throw new Error(`不应调用 ${method}`);
	});
}

describe("Codex 原生投递保留 composer", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.connect.mockImplementation(async (operation) => operation({ request: mocks.request }));
		installNativeResponses();
	});

	it.each(["text", "input_text"])("提交独立原生消息并以实际 %s userMessage 确认", async (type) => {
		installNativeResponses({ nativeMessageContent: [{ type, text: PROMPT }] });
		const input = createInput();
		expect(await deliverCodexNativePromptWithoutChangingComposer(input)).toEqual({
			status: "confirmed",
			evidence: {
				clientUserMessageId: CLIENT_MESSAGE_ID,
				nativeSessionId: "thread-1",
				nativeTurnId: "native-turn-2",
				nativeUserMessageId: "native-user-2",
			},
		});
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toEqual([
			[
				"turn/start",
				{
					threadId: "thread-1",
					turnTrigger: "user",
					clientUserMessageId: CLIENT_MESSAGE_ID,
					input: [{ type: "text", text: PROMPT, text_elements: [] }],
				},
			],
		]);
		expect(input.onRequestAttempted).toHaveBeenCalledOnce();
	});

	it("text 与 input_text 分片拼接后精确匹配时确认且只提交一次", async () => {
		installNativeResponses({
			nativeMessageContent: [
				{ type: "text", text: "程序化投递\n" },
				{ type: "input_text", text: "中文😀  \n" },
			],
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("confirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each([
		{ name: "text 正文不匹配", content: [{ type: "text", text: `${PROMPT}其他内容` }] },
		{ name: "input_text 正文不匹配", content: [{ type: "input_text", text: `${PROMPT}其他内容` }] },
		{
			name: "混合文本包含额外正文",
			content: [
				{ type: "text", text: PROMPT },
				{ type: "input_text", text: "其他内容" },
			],
		},
		{
			name: "混合内容包含非文本部分",
			content: [{ type: "text", text: PROMPT }, { type: "image" }],
		},
		{
			name: "混合内容缺少文本正文",
			content: [{ type: "text", text: PROMPT }, { type: "input_text" }],
		},
	])("$name 时不误认成功，也不重发", async ({ content }) => {
		installNativeResponses({ nativeMessageContent: content });
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each(["text", "input_text"])("请求已写出后报错，但 %s 原生消息 ID 可精确关联时读回确认且不重发", async (type) => {
		installNativeResponses({
			submitThrowsAfterAcceptance: true,
			echoClientMessageId: true,
			nativeMessageContent: [{ type, text: PROMPT }],
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("confirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each(["text", "input_text"])(
		"响应丢失且 %s 原生消息没有回显客户端 ID 时，不能只凭同文冒领确认或重发",
		async (type) => {
			installNativeResponses({
				submitThrowsAfterAcceptance: true,
				nativeMessageContent: [{ type, text: PROMPT }],
			});
			expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
			expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
		},
	);

	it("只有 API 返回、没有原生用户消息时不报送达，也不重发", async () => {
		installNativeResponses({ neverAccepted: true });
		expect(await deliverCodexNativePromptWithoutChangingComposer(createInput())).toEqual({ status: "unconfirmed" });
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it("先前相同正文的 userMessage 不能确认新投递", async () => {
		installNativeResponses({ neverAccepted: true });
		const original = mocks.request.getMockImplementation();
		mocks.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list")
				return {
					data: [
						{
							id: "prior-turn",
							status: "completed",
							items: [{ id: "old-message", type: "userMessage", content: [{ type: "text", text: PROMPT }] }],
						},
					],
					nextCursor: null,
				};
			return original?.(method, parameters);
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
	});

	it.each(["workspaceId", "conversationSessionId", "runtimeSessionIncarnationId"])(
		"端点 %s 不匹配时不连接",
		async (field) => {
			const input = createInput();
			Object.assign(input.summary.codexNativeSessionControlEndpoint ?? {}, { [field]: "another-session" });
			expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unavailable");
			expect(mocks.connect).not.toHaveBeenCalled();
		},
	);

	it("原生回合仍在运行时让路，不将独立消息合并进旧回合", async () => {
		mocks.request.mockImplementation(async (method: string) => {
			if (method === "thread/loaded/list") return { data: ["thread-1"], nextCursor: null };
			if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace" } };
			return { data: [{ id: "prior-turn", status: "inProgress", items: [] }], nextCursor: null };
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("not_ready");
		expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
	});

	it("读取期间换代或领域核验拒绝时不提交", async () => {
		const input = createInput({ beforeSubmit: vi.fn(async () => false) });
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("cancelled");
		expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
	});

	it("已加载会话分页受整体预检预算限制，不累加成无界等待", async () => {
		let clock = 0;
		let pageCount = 0;
		mocks.request.mockImplementation(async (method: string) => {
			expect(method).toBe("thread/loaded/list");
			clock += 4000;
			return { data: [], nextCursor: `page-${++pageCount}` };
		});
		const input = createInput({ now: () => clock });
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unavailable");
		expect(pageCount).toBeLessThanOrEqual(4);
		expect(input.onRequestAttempted).not.toHaveBeenCalled();
	});
	it.each([117_160, 129_828, 120_347])(
		"同一正文在 %i ms 自动压缩后确认，原生请求只发送一次",
		async (compactionDurationMs) => {
			let clock = 0;
			let attempted = false;
			let state = createCodexRvfCloseoutCompactionAwareConfirmation({
				binding: {
					workspaceId: "workspace-1",
					taskId: "task-1",
					conversationSessionId: "conversation-1",
					decisionToken: "token",
					runId: "run",
					handoffSha256: "a".repeat(64),
					idempotencyKey: "key",
					promptSha256: "b".repeat(64),
					nativeSessionId: "thread-1",
					runtimeSessionIncarnationId: INCARNATION_ID,
					controlHostSocketPath: "/isolated/control.sock",
					terminalSessionSpawnedAtEpochMs: 0,
				},
				firstSubmissionAtEpochMs: 0,
				submissionTransport: "codex_native_request",
				clientUserMessageId: CLIENT_MESSAGE_ID,
				predecessorNativeTurnId: "prior-turn",
				lastHumanInputAtSubmission: null,
			});
			mocks.request.mockImplementation(async (method: string) => {
				if (method === "thread/loaded/list") return { data: ["thread-1"], nextCursor: null };
				if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace" } };
				if (method === "turn/start") {
					attempted = true;
					return { turn: { id: "native-turn-2" } };
				}
				return {
					data: [
						{
							id: attempted ? "native-turn-2" : "prior-turn",
							status: "inProgress",
							items:
								attempted && clock >= 3000 + compactionDurationMs
									? [{ id: "native-user-2", type: "userMessage", content: [{ type: "text", text: PROMPT }] }]
									: [],
						},
					],
					nextCursor: null,
				};
			});
			// 首次 preflight 需要已结束的前驱；其后只改变事件调度，不改变 payload 或绑定。
			const request = mocks.request.getMockImplementation();
			mocks.request.mockImplementation(async (method: string) => {
				const response = await request?.(method);
				if (!attempted && method === "thread/turns/list")
					return { data: [{ id: "prior-turn", status: "completed", items: [] }], nextCursor: null };
				return response;
			});
			const input = createInput({
				now: () => clock,
				confirmationDeadlineAtEpochMs: async () => resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(state),
				waitMilliseconds: async (milliseconds) => {
					clock += milliseconds;
					if (clock === 3000 || clock === 3000 + Math.ceil(compactionDurationMs / 250) * 250)
						state = applyCodexAutomaticCompactionPhaseObservation(state, {
							phase: clock === 3000 ? "started" : "completed",
							nativeTurnId: "native-turn-2",
							capturedAtEpochMs: clock,
							receivedAtEpochMs: clock,
							hookDeliveryId: String(clock),
						});
				},
			});
			expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("confirmed");
			expect(clock).toBeGreaterThan(15_000);
			expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
		},
	);

	it("热接管截止后先只读核对接受事实，无法证明时有界返回，不重发", async () => {
		installNativeResponses({ neverAccepted: true });
		const input = createInput({
			previouslySubmitted: { predecessorNativeTurnId: "prior-turn", nativeTurnId: "native-turn-2" },
			confirmationDeadlineAtEpochMs: async () => 0,
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unconfirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "thread/turns/list")).toHaveLength(1);
		expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
		expect(input.onRequestAttempted).not.toHaveBeenCalled();
	});

	it("接管时控制宿主不可达也不会超过截止无限重试", async () => {
		mocks.connect.mockRejectedValue(new Error("隔离控制宿主不可达"));
		const input = createInput({
			previouslySubmitted: { predecessorNativeTurnId: "prior-turn", nativeTurnId: "native-turn-2" },
			confirmationDeadlineAtEpochMs: async () => 0,
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unconfirmed");
		expect(mocks.connect).toHaveBeenCalledOnce();
	});

	describe("真实提交前 validator 与原生 sender 的确认预算", () => {
		let queuedEntry: QueuedTaskPromptDeliveryEntry;
		beforeEach(async () => {
			mocks.isolatedRuntimeHomePath = await mkdtemp(join(tmpdir(), "kanban-native-confirmation-budget-"));
			mocks.queryRecoveryClockEpochMs = 1_800_000_000_000;
			queuedEntry = queuedTaskPromptDeliveryEntrySchema.parse({
				queueEntryId: "independent-message-entry",
				taskId: "conversation-1",
				text: PROMPT,
				deliverTogetherWithNextQueuedEntry: false,
				sourcePromptLibraryEntryId: null,
				sourcePromptLibraryEntryTextSha256: null,
				deliveryState: "handed_to_transport",
				deliveryAttemptCount: 1,
				lastAttemptedAt: mocks.queryRecoveryClockEpochMs,
				settledAt: null,
				dispatchIdempotencyKey: "independent-message-key",
				claimedForSessionIncarnationId: INCARNATION_ID,
				claimedAtTurnSequence: 1,
				enqueuedAt: mocks.queryRecoveryClockEpochMs,
				expiresAt: mocks.queryRecoveryClockEpochMs + 60_000,
				lastDeliveryFailureNote: null,
				survivedRuntimeRestartAtEpochMs: null,
				humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
				custodianRuntimeProcessInstanceId: "isolated-native-delivery-runtime",
				requiredNativeIndependentUserTurnSessionId: "thread-1",
				requiredNativeIndependentUserTurnSessionIncarnationId: INCARNATION_ID,
				nativeIndependentUserTurnSubmissionProgress: {
					predecessorNativeTurnId: "prior-turn",
					submissionMayHaveStartedAtEpochMs: null,
				},
				programmaticInjectionLedgerReceiptLink: {
					injectionLedgerIdempotencyKey: "independent-message-key",
					injectionSource: "isolated-native-delivery-test",
					settledTerminalDeliveryReceipt: null,
				},
			});
			await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
				"workspace-1",
				() => ({ next: { entriesByTaskId: { "conversation-1": [queuedEntry] } }, result: null }),
				mocks.queryRecoveryClockEpochMs,
				"isolated-confirmation-budget-fixture",
			);
		});

		afterEach(async () => {
			await rm(mocks.isolatedRuntimeHomePath, { recursive: true, force: true });
		});

		async function readPersistedEntry() {
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace-1");
			return snapshot.entriesByTaskId["conversation-1"][0];
		}

		function createRecoveringDelivery(
			options: {
				onRecoveredQuery?: () => void;
				onSnapshotChanged?: (snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) => Promise<void>;
				isCurrent?: () => boolean;
			} = {},
		) {
			const readNativeConversationTurns = vi.fn(async (): Promise<CodexNativeConversationTurn[]> => {
				if (readNativeConversationTurns.mock.calls.length <= 4) {
					mocks.queryRecoveryClockEpochMs += 2_000;
					throw new NativeIndependentUserTurnDeliveryError(
						"native_independent_user_turn_capability_unavailable",
						"原生实时查询超时：thread/turns/list",
						{ retryableQueryFailure: true },
					);
				}
				options.onRecoveredQuery?.();
				return [{ id: "prior-turn", status: "completed", items: [] }];
			});
			const validator = createNativeIndependentUserTurnBeforeSubmissionValidator({
				workspaceId: "workspace-1",
				entry: queuedEntry,
				predecessorNativeTurnId: "prior-turn",
				text: PROMPT,
				now: () => mocks.queryRecoveryClockEpochMs,
				isStopped: () => false,
				whenStopped: new Promise<void>(() => {}),
				readNativeConversationTurns,
				onSnapshotChanged: options.onSnapshotChanged ?? (async () => {}),
			});
			const input = createInput({
				now: () => mocks.queryRecoveryClockEpochMs,
				waitMilliseconds: async (milliseconds) => {
					mocks.queryRecoveryClockEpochMs += milliseconds;
				},
				isCurrent: options.isCurrent ?? (() => true),
				beforeSubmit: async () => {
					await validator("before_first_transport_write");
					return true;
				},
			});
			return { input, readNativeConversationTurns };
		}

		it.each([0, 14_750, null])(
			"四次查询超时及持久退避后，接受延迟 %s 仍获得完整有界确认机会且只提交一次",
			async (acceptanceDelayMs) => {
				const startedAtEpochMs = mocks.queryRecoveryClockEpochMs;
				let submittedAtEpochMs: number | null = null;
				let confirmationQueryCount = 0;
				const originalRequest = mocks.request.getMockImplementation();
				mocks.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
					if (method === "turn/start") {
						submittedAtEpochMs = mocks.queryRecoveryClockEpochMs;
						expect((await readPersistedEntry()).nativeIndependentUserTurnSubmissionProgress).toMatchObject({
							submissionMayHaveStartedAtEpochMs: submittedAtEpochMs,
						});
					}
					if (method === "thread/turns/list" && submittedAtEpochMs !== null) {
						confirmationQueryCount += 1;
						if (
							acceptanceDelayMs === null ||
							mocks.queryRecoveryClockEpochMs - submittedAtEpochMs < acceptanceDelayMs
						)
							return { data: [{ id: "prior-turn", status: "completed", items: [] }], nextCursor: null };
					}
					return originalRequest?.(method, parameters);
				});
				const { input, readNativeConversationTurns } = createRecoveringDelivery();
				const result = await deliverCodexNativePromptWithoutChangingComposer(input);
				expect(submittedAtEpochMs).toBe(startedAtEpochMs + 23_000);
				expect(readNativeConversationTurns).toHaveBeenCalledTimes(5);
				expect(input.onRequestAttempted).toHaveBeenCalledOnce();
				expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
				expect(confirmationQueryCount).toBeGreaterThan(0);
				expect(result.status).toBe(acceptanceDelayMs === null ? "unconfirmed" : "confirmed");
				if (result.status === "confirmed") expect(result.evidence.nativeUserMessageId).toBe("native-user-2");
				expect(mocks.queryRecoveryClockEpochMs - (submittedAtEpochMs ?? 0)).toBe(acceptanceDelayMs ?? 15_000);
				expect((await readPersistedEntry()).nativeIndependentUserTurnBeforeSubmissionQueryRecovery).toMatchObject({
					consecutiveQueryFailureCount: 4,
					recoveredAtEpochMs: submittedAtEpochMs,
				});
				expect((await readPersistedEntry()).expiresAt).toBe(queuedEntry.expiresAt);
			},
		);

		it.each(["cancelled", "expired", "session_replaced"] as const)(
			"长时间提交前恢复期间 %s 仍阻止原生提交，并保留原截止时间",
			async (interruption) => {
				let isCurrent = true;
				const { input } = createRecoveringDelivery({
					isCurrent: () => isCurrent,
					onRecoveredQuery: () => {
						if (interruption === "session_replaced") isCurrent = false;
					},
					onSnapshotChanged: async (snapshot) => {
						const entry = snapshot.entriesByTaskId["conversation-1"][0];
						if (entry.nativeIndependentUserTurnBeforeSubmissionQueryRecovery?.consecutiveQueryFailureCount !== 4)
							return;
						if (interruption === "cancelled")
							await mutateWorkspaceQueuedTaskPromptDeliveries(
								"workspace-1",
								{
									kind: "cancel_queued_prompt_delivery",
									taskId: entry.taskId,
									queueEntryId: entry.queueEntryId,
								},
								mocks.queryRecoveryClockEpochMs,
							);
						if (interruption === "expired") mocks.queryRecoveryClockEpochMs = queuedEntry.expiresAt;
					},
				});
				expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe(
					interruption === "session_replaced" ? "cancelled" : "unavailable",
				);
				expect(input.onRequestAttempted).not.toHaveBeenCalled();
				expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
				const persistedEntry = await readPersistedEntry();
				expect(persistedEntry.expiresAt).toBe(queuedEntry.expiresAt);
				if (interruption !== "session_replaced") {
					expect(persistedEntry.deliveryState).toBe(interruption);
					expect(
						persistedEntry.nativeIndependentUserTurnSubmissionProgress?.submissionMayHaveStartedAtEpochMs,
					).toBeNull();
				}
			},
		);
	});
});
