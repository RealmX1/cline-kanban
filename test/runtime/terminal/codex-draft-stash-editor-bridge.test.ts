import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as promptLibraryStore from "../../../src/state/prompt-library-store";
import {
	mutateWorkspacePromptLibrary,
	readWorkspacePromptLibrarySnapshot,
} from "../../../src/state/prompt-library-store";
import {
	getCodexDraftStashOperationDirectory,
	prepareCodexDraftStashEditorBridge,
	readCodexDraftEditorReservation,
	readCodexDraftStashEditorBridge,
	readCodexDraftStashJson,
	reserveCodexDraftEditorInvocation,
	runCodexDraftStashEditorInvocation,
	writeCodexDraftStashJsonDurably,
} from "../../../src/terminal/codex-draft-stash-editor-bridge";
import {
	captureCodexDraftForProfileAdoption,
	createCodexCapturedDraftPromptRecoveryCoordinator,
	readCodexDraftStashOperationStatus,
	recoverCapturedCodexDraftStashOperations,
	runCodexDraftStashOperation,
	saveCapturedCodexDraftPrompt,
} from "../../../src/terminal/codex-draft-stash-operation";

let isolatedHomeDirectoryPath: string;
beforeEach(async () => {
	isolatedHomeDirectoryPath = await mkdtemp(join(tmpdir(), "codex-stash-"));
	vi.stubEnv("HOME", isolatedHomeDirectoryPath);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(isolatedHomeDirectoryPath, { recursive: true, force: true });
});

async function prepareInvocationFixture(text: string) {
	const bridge = await prepareCodexDraftStashEditorBridge({
		workspaceId: "isolated-workspace",
		conversationSessionId: "isolated-conversation",
		runtimeSessionIncarnationId: randomUUID(),
		environment: {},
	});
	const nativeEditorFilePath = join(isolatedHomeDirectoryPath, "native-editor-file.md");
	await writeFile(nativeEditorFilePath, text);
	let editorCompletion: Promise<number> | undefined;
	const triggerExport = () => {
		editorCompletion = runCodexDraftStashEditorInvocation(bridge.directoryPath, nativeEditorFilePath);
	};
	return { bridge, nativeEditorFilePath, triggerExport, editorCompletion: () => editorCompletion };
}

describe("Codex 原生草稿暂存协议", () => {
	it("配置安全续接捕获完整草稿而不清框或写入 Prompts，恢复扫描也不会写库", async () => {
		const text = "完整文字\n包含中文、emoji 🐈 与末尾空白  \n";
		const fixture = await prepareInvocationFixture(text);
		const captured = vi.fn();
		const result = await captureCodexDraftForProfileAdoption({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId: randomUUID(),
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmOriginalComposerRestored: async () => (await fixture.editorCompletion()) === 1,
			persistCapturedDraft: captured,
		});
		expect(result?.text).toBe(text);
		expect(captured).toHaveBeenCalledExactlyOnceWith(text);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe(text);
		await recoverCapturedCodexDraftStashOperations("isolated-workspace");
		expect(
			(await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId["isolated-task"],
		).toBeUndefined();
	});
	it("配置安全续接遇到附件或保存失败保留原始 composer", async () => {
		for (const text of ["正文 [Image #1]", "保存失败也保留正文  "]) {
			const fixture = await prepareInvocationFixture(text);
			const result = await captureCodexDraftForProfileAdoption({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: randomUUID(),
				isCurrent: () => true,
				triggerExport: fixture.triggerExport,
				confirmOriginalComposerRestored: async () => (await fixture.editorCompletion()) === 1,
				persistCapturedDraft: () => {
					throw new Error("隔离模拟保存失败");
				},
			});
			expect(result).toBeNull();
			expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe(text);
		}
	});
	it("存量非 UUID 代际按桥接未就绪读取，但不能用它创建新桥接", async () => {
		const identity = {
			workspaceId: "isolated-workspace",
			conversationSessionId: "isolated-conversation",
			runtimeSessionIncarnationId: "old-process",
		};
		expect(readCodexDraftStashEditorBridge(identity)).toBeNull();
		await expect(prepareCodexDraftStashEditorBridge({ ...identity, environment: {} })).rejects.toThrow();
	});
	it("持久桥接的代际与当前会话不一致时拒绝读取，不接受其它字段相同的旧桥接", async () => {
		const fixture = await prepareInvocationFixture("当前会话的原稿");
		const { directoryPath, ...specification } = fixture.bridge;
		writeCodexDraftStashJsonDurably(join(directoryPath, "bridge-specification.json"), {
			...specification,
			runtimeSessionIncarnationId: randomUUID(),
		});
		expect(() => readCodexDraftStashEditorBridge(specification)).toThrow("当前会话身份不匹配");
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("当前会话的原稿");
	});
	it("自动补证有界重试三次；库发生后续写入时自动恢复，且不再次清框", async () => {
		const fixture = await prepareInvocationFixture("等待自动补证的原稿  ");
		const operationId = randomUUID();
		await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId,
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => false,
			saveCapturedPrompt: async () => {
				throw new Error("初次写入不可用");
			},
		});
		expect(await fixture.editorCompletion()).toBe(1);
		const writeFailure = vi
			.spyOn(promptLibraryStore, "mutateWorkspacePromptLibrary")
			.mockRejectedValue(new Error("存储仍不可用"));
		const recovery = createCodexCapturedDraftPromptRecoveryCoordinator("isolated-workspace");
		try {
			const progressPath = join(
				getCodexDraftStashOperationDirectory("isolated-workspace", operationId),
				"recovery-progress.json",
			);
			await vi.waitFor(
				() =>
					expect(readCodexDraftStashJson(progressPath)).toMatchObject({
						attemptsStarted: 3,
						nextAttemptAtMs: null,
						recoveryCondition: "prompt_library_change_or_runtime_restart",
					}),
				{ timeout: 10_000 },
			);
			expect(writeFailure).toHaveBeenCalledTimes(3);
			writeFailure.mockRestore();
			await mutateWorkspacePromptLibrary("isolated-workspace", {
				kind: "upsert_prompt",
				promptId: randomUUID(),
				text: "后续正常写入触发恢复",
				scope: "repo",
			});
			await vi.waitFor(() =>
				expect(readCodexDraftStashOperationStatus("isolated-workspace", "isolated-task", operationId).outcome).toBe(
					"stashed_into_prompt_library_but_input_box_not_cleared",
				),
			);
			expect(
				(await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId[
					"isolated-task"
				]?.map((entry) => entry.text),
			).toEqual(["等待自动补证的原稿  "]);
			expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("等待自动补证的原稿  ");
		} finally {
			recovery.dispose();
		}
	});
	it("多标签页并发使用不同操作 ID 也只允许一次原生导出", async () => {
		const fixture = await prepareInvocationFixture("并发草稿  ");
		const triggerExport = vi.fn(fixture.triggerExport);
		const request = {
			bridge: fixture.bridge,
			taskId: "isolated-task",
			isCurrent: () => true,
			triggerExport,
			confirmInputBoxEmpty: async () => (await readFile(fixture.nativeEditorFilePath, "utf8")) === "",
		};
		const first = runCodexDraftStashOperation({ ...request, operationId: randomUUID() });
		const second = await runCodexDraftStashOperation({ ...request, operationId: randomUUID() });
		expect(second.outcome).toBe("another_terminal_input_box_stash_attempt_already_in_flight_for_this_task");
		expect((await first).outcome).toBe("stashed_into_prompt_library");
		expect(triggerExport).toHaveBeenCalledTimes(1);
		expect(
			(await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId["isolated-task"],
		).toHaveLength(1);
	});

	it("配置安全续接捕获超时或确认失败后释放预约，随后可再次捕获", async () => {
		const fixture = await prepareInvocationFixture("超时后仍可再次捕获的原稿");
		vi.useFakeTimers();
		try {
			const timedOut = captureCodexDraftForProfileAdoption({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: randomUUID(),
				isCurrent: () => true,
				triggerExport: () => {},
				confirmOriginalComposerRestored: async () => false,
				persistCapturedDraft: () => {
					throw new Error("超时路径不应保存");
				},
			});
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await timedOut).toBeNull();
			expect(readCodexDraftEditorReservation(fixture.bridge)).toBeNull();

			const unconfirmedOperationId = randomUUID();
			const unconfirmed = captureCodexDraftForProfileAdoption({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: unconfirmedOperationId,
				isCurrent: () => true,
				triggerExport: () => {
					writeCodexDraftStashJsonDurably(
						join(
							getCodexDraftStashOperationDirectory("isolated-workspace", unconfirmedOperationId),
							"editor-finished.json",
						),
						{ exitCode: 1, finishedAtMs: Date.now() },
					);
				},
				confirmOriginalComposerRestored: async () => false,
				persistCapturedDraft: () => {
					throw new Error("未确认路径不应保存");
				},
			});
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await unconfirmed).toBeNull();
			expect(readCodexDraftEditorReservation(fixture.bridge)).toBeNull();

			const captured = captureCodexDraftForProfileAdoption({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: randomUUID(),
				isCurrent: () => true,
				triggerExport: fixture.triggerExport,
				confirmOriginalComposerRestored: async () => (await fixture.editorCompletion()) === 1,
				persistCapturedDraft: () => {},
			});
			await vi.advanceTimersByTimeAsync(5_000);
			expect((await captured)?.text).toBe("超时后仍可再次捕获的原稿");
			expect(readCodexDraftEditorReservation(fixture.bridge)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("编辑器回执缺失导致失败后释放预约，后续暂存无需重启会话", async () => {
		const fixture = await prepareInvocationFixture("回执缺失后仍可暂存的原稿  ");
		vi.useFakeTimers();
		try {
			const first = runCodexDraftStashOperation({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: randomUUID(),
				isCurrent: () => true,
				triggerExport: () => {},
				confirmInputBoxEmpty: async () => false,
			});
			await vi.advanceTimersByTimeAsync(23_000);
			expect(await first).toMatchObject({
				outcome: "codex_draft_export_failed",
				capturedDraftPromptSaveRecoveryPending: false,
			});

			const second = runCodexDraftStashOperation({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId: randomUUID(),
				isCurrent: () => true,
				triggerExport: fixture.triggerExport,
				confirmInputBoxEmpty: async () => (await readFile(fixture.nativeEditorFilePath, "utf8")) === "",
			});
			await vi.advanceTimersByTimeAsync(5_000);
			expect((await second).outcome).toBe("stashed_into_prompt_library");
			expect(await fixture.editorCompletion()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("已声明但未完成捕获的编辑器保持补证状态，不能仅凭超时放弃固定操作", async () => {
		const fixture = await prepareInvocationFixture("捕获状态未知的原稿");
		const operationId = randomUUID();
		vi.useFakeTimers();
		try {
			const attempt = runCodexDraftStashOperation({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId,
				isCurrent: () => true,
				triggerExport: () => {
					writeCodexDraftStashJsonDurably(
						join(
							getCodexDraftStashOperationDirectory("isolated-workspace", operationId),
							"editor-invocation-claimed",
						),
						{},
					);
				},
				confirmInputBoxEmpty: async () => false,
			});
			await vi.advanceTimersByTimeAsync(23_000);
			expect(await attempt).toMatchObject({
				outcome: "codex_draft_export_failed",
				capturedDraftPromptSaveRecoveryPending: true,
			});
			expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("捕获状态未知的原稿");
		} finally {
			vi.useRealTimers();
		}
	});

	it("超过捕获期限才启动的编辑器非零退出，不再捕获或保存正文", async () => {
		const fixture = await prepareInvocationFixture("迟到编辑器的原稿  \n");
		const operationId = randomUUID();
		vi.useFakeTimers();
		try {
			const attempt = runCodexDraftStashOperation({
				bridge: fixture.bridge,
				taskId: "isolated-task",
				operationId,
				isCurrent: () => true,
				triggerExport: () => {
					setTimeout(fixture.triggerExport, 11_000);
				},
				confirmInputBoxEmpty: async () => false,
			});
			await vi.advanceTimersByTimeAsync(23_000);
			expect(await attempt).toMatchObject({
				outcome: "codex_draft_export_failed",
				capturedDraftPromptSaveRecoveryPending: false,
			});
			expect(await fixture.editorCompletion()).toBe(1);
			expect(
				readCodexDraftStashJson(
					join(getCodexDraftStashOperationDirectory("isolated-workspace", operationId), "captured-draft.json"),
				),
			).toBeNull();
			expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("迟到编辑器的原稿  \n");
		} finally {
			vi.useRealTimers();
		}
	});

	it("人工 Ctrl+G 的预约不能被 Ctrl+S 抢走", async () => {
		const fixture = await prepareInvocationFixture("人工编辑草稿");
		expect(reserveCodexDraftEditorInvocation(fixture.bridge, { origin: "manual", invocationId: randomUUID() })).toBe(
			true,
		);
		const triggerExport = vi.fn();
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId: randomUUID(),
			isCurrent: () => true,
			triggerExport,
			confirmInputBoxEmpty: async () => true,
		});
		expect(result.outcome).toBe("another_terminal_input_box_stash_attempt_already_in_flight_for_this_task");
		expect(triggerExport).not.toHaveBeenCalled();
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("人工编辑草稿");
	});

	it("原编辑器命令和带空格参数逐项保留，人工 Ctrl+G 不写 Prompt Library", async () => {
		const editorScriptPath = join(isolatedHomeDirectoryPath, "original editor.cjs");
		const editorEvidencePath = join(isolatedHomeDirectoryPath, "original-editor-observation.json");
		await writeFile(
			editorScriptPath,
			`require('node:fs').writeFileSync(${JSON.stringify(editorEvidencePath)},JSON.stringify({arguments:process.argv.slice(2),visual:process.env.VISUAL,editor:process.env.EDITOR}));`,
		);
		const originalVisual = `'${process.execPath}' '${editorScriptPath}' --wait '带空格 参数'`;
		const bridge = await prepareCodexDraftStashEditorBridge({
			workspaceId: "isolated-workspace",
			conversationSessionId: "isolated-conversation",
			runtimeSessionIncarnationId: randomUUID(),
			environment: { VISUAL: originalVisual, EDITOR: "another-editor --flag" },
		});
		const nativeEditorFilePath = join(isolatedHomeDirectoryPath, "native-editor-file.md");
		await writeFile(nativeEditorFilePath, "原稿  \n");
		expect(await runCodexDraftStashEditorInvocation(bridge.directoryPath, nativeEditorFilePath)).toBe(0);
		expect(JSON.parse(await readFile(editorEvidencePath, "utf8"))).toEqual({
			arguments: ["--wait", "带空格 参数", nativeEditorFilePath],
			visual: originalVisual,
			editor: "another-editor --flag",
		});
		expect(await readFile(nativeEditorFilePath, "utf8")).toBe("原稿  \n");
		expect((await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId).toEqual({});
	});

	it("重启后的捕获补写使用同一个 Prompt ID，并保留原失败历史", async () => {
		const fixture = await prepareInvocationFixture("运行时重启时的草稿  \n\n");
		const operationId = randomUUID();
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId,
			isCurrent: () => false,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => false,
			saveCapturedPrompt: async () => {
				throw new Error("重启前写入中断");
			},
		});
		expect(result.outcome).toBe("prompt_library_write_failed");
		expect(result.capturedDraftPromptSaveRecoveryPending).toBe(true);
		expect(await fixture.editorCompletion()).toBe(1);
		await recoverCapturedCodexDraftStashOperations("isolated-workspace");
		await recoverCapturedCodexDraftStashOperations("isolated-workspace");
		const status = readCodexDraftStashOperationStatus("isolated-workspace", "isolated-task", operationId);
		expect(status.outcome).toBe("stashed_into_prompt_library_but_input_box_not_cleared");
		const entries = (await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId[
			"isolated-task"
		];
		expect(entries?.map((entry) => entry.id)).toEqual([status.stashedPromptId]);
		expect(
			readCodexDraftStashJson(
				join(getCodexDraftStashOperationDirectory("isolated-workspace", operationId), "failure.json"),
			),
		).toMatchObject({ outcome: "prompt_library_write_failed" });
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("运行时重启时的草稿  \n\n");
	});

	it("写库已完成但保存回执丢失时，恢复不能覆盖用户后来的编辑", async () => {
		const fixture = await prepareInvocationFixture("原始草稿");
		const operationId = randomUUID();
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId,
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => true,
		});
		if (!result.stashedPromptId) throw new Error("缺少保存回执");
		await mutateWorkspacePromptLibrary("isolated-workspace", {
			kind: "upsert_prompt",
			promptId: result.stashedPromptId,
			text: "用户后来的编辑",
			scope: "task",
			taskId: "isolated-task",
		});
		await unlink(join(getCodexDraftStashOperationDirectory("isolated-workspace", operationId), "prompt-saved.json"));
		await recoverCapturedCodexDraftStashOperations("isolated-workspace");
		expect(
			(await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId[
				"isolated-task"
			]?.map((entry) => entry.text),
		).toEqual(["用户后来的编辑"]);
	});

	it("写库等待超时先非零返回；迟到的完成只补保存证据，绝不追补清框", async () => {
		const fixture = await prepareInvocationFixture("超时原稿  \n");
		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, timeout, ...arguments_) =>
			originalSetTimeout(callback, timeout && timeout >= 9_000 && timeout <= 10_000 ? 5 : timeout, ...arguments_),
		);
		let finishLateWrite: (() => Promise<void>) | undefined;
		const operationId = randomUUID();
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId,
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => true,
			saveCapturedPrompt: (operation) =>
				new Promise<void>((resolve) => {
					finishLateWrite = async () => {
						await saveCapturedCodexDraftPrompt(operation);
						resolve();
					};
				}),
		});
		expect(result.outcome).toBe("prompt_library_write_failed");
		expect(await fixture.editorCompletion()).toBe(1);
		if (!finishLateWrite) throw new Error("缺少在途写入");
		await finishLateWrite();
		expect(readCodexDraftStashOperationStatus("isolated-workspace", "isolated-task", operationId).outcome).toBe(
			"stashed_into_prompt_library_but_input_box_not_cleared",
		);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("超时原稿  \n");
	});
	it("原文逐字入库，成功之后才向原生编辑器返回空文件；重放操作不重复导出或写库", async () => {
		const text = `  开头 😀\n${"中文 English  ".repeat(300)}\n末尾  \n\n`;
		const fixture = await prepareInvocationFixture(text);
		const operationId = randomUUID();
		const triggerExport = vi.fn(fixture.triggerExport);
		const request = {
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId,
			isCurrent: () => true,
			triggerExport,
			confirmInputBoxEmpty: async () => (await readFile(fixture.nativeEditorFilePath, "utf8")) === "",
		};
		const result = await runCodexDraftStashOperation(request);
		expect(result.outcome).toBe("stashed_into_prompt_library");
		expect(await fixture.editorCompletion()).toBe(0);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe("");
		const prompts = (await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId[
			"isolated-task"
		];
		expect(prompts?.map((entry) => entry.text)).toEqual([text]);
		expect(await runCodexDraftStashOperation(request)).toEqual(result);
		expect(triggerExport).toHaveBeenCalledTimes(1);
		expect(readCodexDraftStashOperationStatus("isolated-workspace", "isolated-task", operationId)).toEqual(result);
	});

	it("写库失败时非零退出，前后空白仍原样留在原稿", async () => {
		const text = "  不可丢失\n原稿  \n\n";
		const fixture = await prepareInvocationFixture(text);
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId: randomUUID(),
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => false,
			saveCapturedPrompt: async () => {
				throw new Error("隔离写库失败");
			},
		});
		expect(result.outcome).toBe("prompt_library_write_failed");
		expect(await fixture.editorCompletion()).toBe(1);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe(text);
	});

	it("捕获后换代可以保存正文，但不允许旧操作清框", async () => {
		const text = " 换代前原稿  ";
		const fixture = await prepareInvocationFixture(text);
		let current = true;
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId: randomUUID(),
			isCurrent: () => current,
			triggerExport: () => {
				fixture.triggerExport();
				current = false;
			},
			confirmInputBoxEmpty: async () => true,
		});
		expect(result.outcome).toBe("stashed_into_prompt_library_but_input_box_not_cleared");
		expect(await fixture.editorCompletion()).toBe(1);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe(text);
	});

	it("附件占位文字不算完整附件：非零退出且不入库", async () => {
		const text = "附件草稿 [Image #1]  ";
		const fixture = await prepareInvocationFixture(text);
		const result = await runCodexDraftStashOperation({
			bridge: fixture.bridge,
			taskId: "isolated-task",
			operationId: randomUUID(),
			isCurrent: () => true,
			triggerExport: fixture.triggerExport,
			confirmInputBoxEmpty: async () => false,
		});
		expect(result.outcome).toBe("input_box_contains_unsupported_attachments");
		expect(await fixture.editorCompletion()).toBe(1);
		expect(await readFile(fixture.nativeEditorFilePath, "utf8")).toBe(text);
		expect((await readWorkspacePromptLibrarySnapshot("isolated-workspace")).taskScopedPromptsByTaskId).toEqual({});
	});
});
