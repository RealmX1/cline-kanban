import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { RuntimeTerminalInputBoxStashResponse } from "../core/api-contract";
import { runtimeTerminalInputBoxStashResponseSchema, terminalInputBoxStashOutcomeSchema } from "../core/api-contract";
import { logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { mutateWorkspacePromptLibrary, subscribeToPromptLibraryChanges } from "../state/prompt-library-store";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	type CodexDraftStashEditorBridge,
	type CodexDraftStashOperationSpecification,
	codexDraftStashOperationSpecificationSchema,
	getCodexDraftStashOperationDirectory,
	readCodexDraftStashJson,
	releaseCodexDraftEditorReservation,
	reserveCodexDraftEditorInvocation,
	writeCodexDraftStashJsonDurably,
} from "./codex-draft-stash-editor-bridge";

const capturedDraftSchema = z.object({ text: z.string() });
const failureSchema = z.object({ outcome: terminalInputBoxStashOutcomeSchema, error: z.string() });
const editorFinishedSchema = z.object({ exitCode: z.number(), finishedAtMs: z.number() });
export const CODEX_DRAFT_CAPTURE_WAIT_MS = 10_000;
export const CODEX_DRAFT_WRITE_WAIT_MS = 10_000;

function operationFile(operation: CodexDraftStashOperationSpecification, name: string): string {
	return join(getCodexDraftStashOperationDirectory(operation.workspaceId, operation.operationId), name);
}

function persistOperationFile(operation: CodexDraftStashOperationSpecification, name: string, value: unknown): void {
	writeCodexDraftStashJsonDurably(operationFile(operation, name), value);
}

export function readCodexDraftStashOperationStatus(
	workspaceId: string,
	taskId: string,
	operationId: string,
): RuntimeTerminalInputBoxStashResponse {
	const directoryPath = getCodexDraftStashOperationDirectory(workspaceId, operationId);
	const rawOperation = readCodexDraftStashJson(join(directoryPath, "operation.json"));
	const base = { operationId, stashedPromptId: null, stashedTextCharacterCount: 0, fidelity: null };
	const rawResponse = readCodexDraftStashJson(join(directoryPath, "operation-response.json"));
	if (rawResponse !== null) {
		const receipt = z
			.object({ taskId: z.string(), response: runtimeTerminalInputBoxStashResponseSchema })
			.parse(rawResponse);
		if (receipt.taskId !== taskId) throw new Error("草稿回执归属不匹配。");
		if (rawOperation === null) return { ...receipt.response, capturedDraftPromptSaveRecoveryPending: false };
	}
	if (rawOperation === null) return { ...base, ok: false, outcome: "codex_draft_stash_operation_not_found" };
	const operation = codexDraftStashOperationSpecificationSchema.parse(rawOperation);
	if (operation.workspaceId !== workspaceId || operation.taskId !== taskId)
		throw new Error("草稿暂存操作归属不匹配。");
	const captureDeadlineExpired = Date.now() > operation.captureDeadlineAtMs;
	const editorFinished = existsSync(join(directoryPath, "editor-finished.json"));
	const editorInvocationClaimed = existsSync(join(directoryPath, "editor-invocation-claimed"));
	const rawCapture = readCodexDraftStashJson(join(directoryPath, "captured-draft.json"));
	const capture = rawCapture === null ? null : capturedDraftSchema.parse(rawCapture);
	const capturedDraftPromptSaveRecoveryPending =
		(capture !== null && capture.text.length > 0) ||
		(!editorFinished && (editorInvocationClaimed || !captureDeadlineExpired));
	if (existsSync(join(directoryPath, "prompt-saved.json")))
		return {
			...base,
			ok: true,
			stashedPromptId: operation.promptId,
			stashedTextCharacterCount: capture?.text.length ?? 0,
			outcome: existsSync(join(directoryPath, "input-box-clear-confirmed.json"))
				? "stashed_into_prompt_library"
				: "stashed_into_prompt_library_but_input_box_not_cleared",
		};
	const rawFailure = readCodexDraftStashJson(join(directoryPath, "failure.json"));
	if (rawFailure !== null)
		return { ...base, ok: false, capturedDraftPromptSaveRecoveryPending, ...failureSchema.parse(rawFailure) };
	if (Date.now() > operation.writeDeadlineAtMs)
		return {
			...base,
			ok: false,
			capturedDraftPromptSaveRecoveryPending,
			outcome: "codex_draft_export_failed",
			error: "草稿导出或保存未在期限内确认；原稿保留，后续只查询保存证据。",
		};
	return { ...base, ok: true, outcome: "codex_draft_stash_in_progress" };
}

export async function saveCapturedCodexDraftPrompt(operation: CodexDraftStashOperationSpecification): Promise<void> {
	if (operation.purpose === "profile_adoption_capture") throw new Error("配置续接捕获的草稿不能写入 Prompts。");
	if (existsSync(operationFile(operation, "prompt-saved.json"))) return;
	const capture = capturedDraftSchema.parse(readCodexDraftStashJson(operationFile(operation, "captured-draft.json")));
	if (capture.text.length === 0) return;
	const snapshot = await mutateWorkspacePromptLibrary(operation.workspaceId, {
		kind: "upsert_prompt",
		promptId: operation.promptId,
		text: capture.text,
		scope: "task",
		taskId: operation.taskId,
		origin: "terminal_stash_by_user",
		leaveExistingPromptUnchanged: true,
	});
	const entry = [
		...snapshot.globalScopedPrompts,
		...snapshot.repoScopedPrompts,
		...Object.values(snapshot.taskScopedPromptsByTaskId).flat(),
	].find((prompt) => prompt.id === operation.promptId);
	if (!entry) throw new Error("未能读回已保存的固定 Prompt ID。");
	persistOperationFile(operation, "prompt-saved.json", {
		savedAtMs: Date.now(),
		textMatchesCapturedDraft: entry.text === capture.text,
	});
}

export async function runCodexDraftStashOperation(input: {
	bridge: CodexDraftStashEditorBridge;
	taskId: string;
	operationId: string;
	isCurrent: () => boolean;
	triggerExport: () => void;
	confirmInputBoxEmpty: () => Promise<boolean>;
	confirmInputBoxRestoredAfterFailure?: () => Promise<boolean>;
	onClearAuthorized?: () => void;
	saveCapturedPrompt?: typeof saveCapturedCodexDraftPrompt;
}): Promise<RuntimeTerminalInputBoxStashResponse> {
	const { bridge, operationId, taskId } = input;
	const directoryPath = getCodexDraftStashOperationDirectory(bridge.workspaceId, operationId);
	const status = () => readCodexDraftStashOperationStatus(bridge.workspaceId, taskId, operationId);
	// 已登记操作只核对证据，绝不再次发 Ctrl+G。
	if (existsSync(join(directoryPath, "operation.json"))) return status();
	const createdAtMs = Date.now();
	const operation = codexDraftStashOperationSpecificationSchema.parse({
		...bridge,
		taskId,
		operationId,
		promptId: randomUUID(),
		createdAtMs,
		captureDeadlineAtMs: createdAtMs + CODEX_DRAFT_CAPTURE_WAIT_MS,
		writeDeadlineAtMs: createdAtMs + CODEX_DRAFT_CAPTURE_WAIT_MS + CODEX_DRAFT_WRITE_WAIT_MS,
	});
	if (!reserveCodexDraftEditorInvocation(bridge, { origin: "stash", operation }))
		return {
			ok: false,
			operationId,
			outcome: "another_terminal_input_box_stash_attempt_already_in_flight_for_this_task",
			stashedPromptId: null,
			stashedTextCharacterCount: 0,
			fidelity: null,
		};
	mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
	persistOperationFile(operation, "operation.json", operation);
	writeCodexDraftStashJsonDurably(join(bridge.directoryPath, "most-recent-stash-operation.json"), operation);
	let mayClear = false;
	try {
		input.triggerExport();
		while (
			!existsSync(operationFile(operation, "captured-draft.json")) &&
			!existsSync(operationFile(operation, "editor-finished.json")) &&
			Date.now() < operation.captureDeadlineAtMs
		)
			await delay(40);
		const capture = readCodexDraftStashJson(operationFile(operation, "captured-draft.json"));
		if (capture === null) {
			if (!existsSync(operationFile(operation, "failure.json")))
				persistOperationFile(operation, "failure.json", {
					outcome: "codex_draft_export_failed",
					error: "未收到属于本次操作的原生草稿导出，原稿保留。",
				});
		} else if (capturedDraftSchema.parse(capture).text.length === 0) {
			persistOperationFile(operation, "failure.json", {
				outcome: "input_box_empty_nothing_to_stash",
				error: "没有文字草稿，输入框原样保留。",
			});
		} else {
			let timeout: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					(input.saveCapturedPrompt ?? saveCapturedCodexDraftPrompt)(operation),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new Error("草稿写库等待超时，保留原稿并继续核对固定 Prompt ID。")),
							Math.max(1, Math.min(CODEX_DRAFT_WRITE_WAIT_MS, operation.writeDeadlineAtMs - Date.now())),
						);
					}),
				]);
				const saved = readCodexDraftStashJson(operationFile(operation, "prompt-saved.json"));
				mayClear =
					input.isCurrent() &&
					Date.now() < operation.writeDeadlineAtMs &&
					z.object({ textMatchesCapturedDraft: z.boolean() }).parse(saved).textMatchesCapturedDraft;
			} catch (error) {
				persistOperationFile(operation, "failure.json", {
					outcome: "prompt_library_write_failed",
					error: String(error),
				});
			} finally {
				clearTimeout(timeout);
			}
		}
	} catch (error) {
		persistOperationFile(operation, "failure.json", { outcome: "codex_draft_export_failed", error: String(error) });
	} finally {
		if (mayClear) input.onClearAuthorized?.();
		persistOperationFile(operation, "editor-decision.json", {
			operationId,
			allowClear: mayClear,
			clearAllowedUntilMs: operation.writeDeadlineAtMs,
		});
	}
	const returnDeadlineAtMs = operation.writeDeadlineAtMs + 2_000;
	while (!existsSync(operationFile(operation, "editor-finished.json")) && Date.now() < returnDeadlineAtMs)
		await delay(40);
	const rawFinished = readCodexDraftStashJson(operationFile(operation, "editor-finished.json"));
	if (rawFinished !== null && editorFinishedSchema.parse(rawFinished).exitCode === 0 && mayClear) {
		const clearConfirmationDeadlineAtMs = Date.now() + 3_000;
		while (input.isCurrent() && Date.now() < clearConfirmationDeadlineAtMs) {
			if (await input.confirmInputBoxEmpty()) {
				if (input.isCurrent())
					persistOperationFile(operation, "input-box-clear-confirmed.json", { confirmedAtMs: Date.now() });
				break;
			}
			await delay(40);
		}
	}
	if (rawFinished !== null && editorFinishedSchema.parse(rawFinished).exitCode !== 0) {
		const restoreConfirmationDeadlineAtMs = Date.now() + 3_000;
		while (Date.now() < restoreConfirmationDeadlineAtMs) {
			if (!input.confirmInputBoxRestoredAfterFailure || (await input.confirmInputBoxRestoredAfterFailure())) {
				persistOperationFile(operation, "input-box-restored-after-editor-failure.json", {
					confirmedAtMs: Date.now(),
				});
				break;
			}
			await delay(40);
		}
	}
	if (
		rawFinished === null ||
		existsSync(operationFile(operation, "input-box-restored-after-editor-failure.json")) ||
		existsSync(operationFile(operation, "input-box-clear-confirmed.json"))
	)
		releaseCodexDraftEditorReservation(bridge, operationId);
	return status();
}

// runtime 重启后只补写捕获过的正文；既不重新导出，也不授权旧操作清框。
export async function recoverCapturedCodexDraftStashOperations(workspaceId: string): Promise<string[]> {
	const parentDirectoryPath = join(getRuntimeHomePath(), "workspaces", workspaceId, "codex-draft-stash-operations");
	if (!existsSync(parentDirectoryPath)) return [];
	const pendingOperationIds: string[] = [];
	for (const operationId of readdirSync(parentDirectoryPath)) {
		if (!z.uuid().safeParse(operationId).success) continue;
		try {
			const directoryPath = getCodexDraftStashOperationDirectory(workspaceId, operationId);
			if (!existsSync(join(directoryPath, "operation.json"))) continue;
			const operation = codexDraftStashOperationSpecificationSchema.parse(
				readCodexDraftStashJson(join(directoryPath, "operation.json")),
			);
			if (operation.workspaceId !== workspaceId || operation.operationId !== operationId)
				throw new Error("草稿恢复身份不匹配。");
			if (operation.purpose === "profile_adoption_capture") continue;
			if (
				existsSync(join(directoryPath, "captured-draft.json")) &&
				!existsSync(join(directoryPath, "prompt-saved.json"))
			)
				await saveCapturedCodexDraftPrompt(operation);
		} catch (error) {
			pendingOperationIds.push(operationId);
			logTuiFreezeWarning(
				`Codex 草稿恢复待重验 workspaceId=${workspaceId} operationId=${operationId} reason=${String(error)}`,
			);
		}
	}
	return pendingOperationIds;
}

// 自动恢复只补写已捕获正文；三次无进展后，等待库的后续写入或下次 runtime 启动再重验。
export function createCodexCapturedDraftPromptRecoveryCoordinator(workspaceId: string) {
	let disposed = false;
	let inFlight: Promise<void> | null = null;
	let retryTimer: NodeJS.Timeout | null = null;
	let attemptsStarted = 0;
	let hasPendingCapturedDrafts = false;
	const recover = () => {
		if (disposed || inFlight) return;
		attemptsStarted += 1;
		inFlight = (async () => {
			const pendingOperationIds = await recoverCapturedCodexDraftStashOperations(workspaceId);
			hasPendingCapturedDrafts = pendingOperationIds.length > 0;
			if (disposed || pendingOperationIds.length === 0) return;
			const retryDelayMs = attemptsStarted < 3 ? attemptsStarted * 1_000 : null;
			for (const operationId of pendingOperationIds) {
				try {
					writeCodexDraftStashJsonDurably(
						join(getCodexDraftStashOperationDirectory(workspaceId, operationId), "recovery-progress.json"),
						{
							attemptsStarted,
							lastAttemptAtMs: Date.now(),
							nextAttemptAtMs: retryDelayMs === null ? null : Date.now() + retryDelayMs,
							recoveryCondition:
								retryDelayMs === null ? "prompt_library_change_or_runtime_restart" : "bounded_retry_timer",
						},
					);
				} catch (error) {
					logTuiFreezeWarning(`Codex 草稿恢复进度暂不可写 operationId=${operationId} reason=${String(error)}`);
				}
			}
			if (retryDelayMs !== null) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					recover();
				}, retryDelayMs);
				retryTimer.unref?.();
			}
		})()
			.catch((error) => {
				hasPendingCapturedDrafts = true;
				logTuiFreezeWarning(`Codex 草稿恢复待重验 workspaceId=${workspaceId} reason=${String(error)}`);
				if (!disposed && attemptsStarted < 3) {
					retryTimer = setTimeout(() => {
						retryTimer = null;
						recover();
					}, attemptsStarted * 1_000);
					retryTimer.unref?.();
				}
			})
			.finally(() => {
				inFlight = null;
			});
	};
	const unsubscribe = subscribeToPromptLibraryChanges((changedWorkspaceId) => {
		if (changedWorkspaceId !== null && changedWorkspaceId !== workspaceId) return;
		if (!hasPendingCapturedDrafts) return;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		attemptsStarted = 0;
		recover();
	});
	recover();
	return {
		recover: () => {
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			attemptsStarted = 0;
			recover();
		},
		dispose: () => {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
			unsubscribe();
		},
	};
}
