import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideSessionCreationWorkbench } from "@/components/side-session-creation-workbench";
import * as imageUtils from "@/components/task-image-input-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as configQueries from "@/runtime/runtime-config-query";
import * as creationQueries from "@/runtime/task-conversation-session-creation-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins,
	USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import {
	closeSideSessionCreationWorkbench,
	openSideSessionCreationWorkbench,
	readActiveSideSessionCreationDraft,
	type SideSessionCreationWorkbenchTarget,
} from "@/state/side-session-creation-workbench-store";
import { LocalStorageKey } from "@/storage/local-storage-store";

vi.mock("@/hooks/use-codex-configuration-sync", () => ({
	useCodexConfigurationSync: () => ({ state: null, error: null }),
}));

function target(agentId: RuntimeAgentId = "codex"): SideSessionCreationWorkbenchTarget {
	const main = {
		taskId: "abcde",
		agentId,
		startedAt: 1,
		updatedAt: 1,
		workspacePath: "/repo/task",
		pid: 1,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		state: "awaiting_review",
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: agentId,
			nativeSessionId: "source-native",
			transcriptPath: null,
			observedAt: 1,
		},
	} as RuntimeTaskSessionSummary;
	return {
		workspaceId: "project-a",
		task: {
			id: "abcde",
			title: "宿主任务",
			prompt: "宿主正文",
			createdAt: 1,
			updatedAt: 1,
			baseRef: "main",
			startInPlanMode: true,
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "host-temporary-model" },
			codexConfigurationProfileId: "host-temporary-profile",
		},
		mainSessionSummary: main,
		taskSessions: { abcde: main },
		agentId,
	};
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear();
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
	let preferences = { ...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET };
	vi.spyOn(configQueries, "fetchRuntimeConfig").mockImplementation(
		async () => ({ userInterfacePreferencesSharedAcrossBrowserOrigins: preferences }) as RuntimeConfigResponse,
	);
	vi.spyOn(configQueries, "saveRuntimeConfig").mockImplementation(async (_workspace, patch) => {
		preferences = { ...preferences, ...patch.userInterfacePreferencesSharedAcrossBrowserOrigins };
		return { userInterfacePreferencesSharedAcrossBrowserOrigins: preferences } as RuntimeConfigResponse;
	});
	vi.spyOn(configQueries, "fetchTerminalAgentModelSelectionOptions").mockImplementation(async (_workspace, input) => ({
		agentId: input,
		defaultModelId: null,
		defaultLabel: "Agent 默认配置",
		options: [{ modelId: "explicit-model", label: "显式模型" }],
	}));
	vi.spyOn(creationQueries, "submitOrRecoverTaskConversationSessionCreation").mockResolvedValue({
		ok: false,
		creation: null,
		summary: null,
		error: "模拟失败",
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => {
		closeSideSessionCreationWorkbench();
		root.unmount();
	});
	container.remove();
	vi.restoreAllMocks();
});
async function open(value = target()) {
	await act(async () => {
		openSideSessionCreationWorkbench(value);
		root.render(
			<TooltipProvider>
				<SideSessionCreationWorkbench />
			</TooltipProvider>,
		);
	});
}
async function click(text: string) {
	await act(async () =>
		Array.from(document.body.querySelectorAll("button"))
			.find((button) => button.textContent === text)
			?.click(),
	);
}
async function role(value: "by_the_way" | "task_collaborator") {
	await act(async () => {
		const select = document.querySelector<HTMLSelectElement>("#creation-workbench-session-role");
		if (!select) throw new Error("缺少类型选择");
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
async function text(value: string) {
	await act(async () => {
		const input = document.querySelector("textarea");
		if (!input) throw new Error("缺少正文");
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("共享侧会话创建工作台", () => {
	it.each([
		"{不可读原文",
		JSON.stringify({ schemaVersion: 2, activeDraftIdentityByCreationScope: [], draftsByIdentity: [] }),
	])("损坏草稿先完整备份，恢复后的草稿按完整目标与草稿身份保存：%s", async (unreadableDrafts) => {
		window.localStorage.setItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts, unreadableDrafts);
		await open();
		await text("恢复后的草稿");
		expect(
			JSON.parse(
				window.localStorage.getItem(LocalStorageKey.SideSessionCreationWorkbenchUnreadableDraftRecoveryCopies) ??
					"{}",
			).originalText,
		).toBe(unreadableDrafts);
		const saved = JSON.parse(window.localStorage.getItem(LocalStorageKey.SideSessionCreationWorkbenchDrafts) ?? "{}");
		const [identity] = Object.keys(saved.draftsByIdentity);
		expect(JSON.parse(identity ?? "[]")).toEqual(["project-a", "abcde", 1, "task_collaborator", expect.any(String)]);
	});
	it("修改正文后忽略旧预览的迟到结果", async () => {
		let rejectPreview: (reason: Error) => void = () => undefined;
		vi.spyOn(creationQueries, "previewTaskConversationSessionCreation").mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectPreview = reject;
				}),
		);
		await open();
		await click("预览启动设置");
		await text("新的正文");
		await act(async () => {
			rejectPreview(new Error("旧预览失败"));
		});
		expect(document.body.textContent).not.toContain("旧预览失败");
	});
	it.each(["claude", "codex", "omp"] as const)(
		"%s 的空 Peer 默认复刻，Plan 独立关闭且不继承宿主临时模型或 profile",
		async (agentId) => {
			await open(target(agentId));
			expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("false");
			await click("创建会话");
			expect(creationQueries.submitOrRecoverTaskConversationSessionCreation).toHaveBeenCalledWith(
				"project-a",
				expect.objectContaining({
					agentId,
					initialMessage: "",
					startInPlanMode: false,
					taskAgentPermissionMode: "bypass_all_permission_prompts",
					contextSource: "current_main",
					expectedTaskIncarnationCreatedAtEpochMs: 1,
				}),
			);
			const request = vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mock.calls[0]?.[1];
			expect(request?.terminalAgentModelOverrideSettings).toBeUndefined();
			expect(request?.codexConfigurationProfileId).toBeUndefined();
		},
	);
	it.each(["claude", "codex"] as const)("%s 的 By the way 可空启动并保持角色只读", async (agentId) => {
		await open(target(agentId));
		await role("by_the_way");
		await click("创建会话");
		expect(creationQueries.submitOrRecoverTaskConversationSessionCreation).toHaveBeenCalledWith(
			"project-a",
			expect.objectContaining({ sessionRole: "by_the_way", agentId, initialMessage: "", startInPlanMode: false }),
		);
		expect(document.body.textContent).toContain("持续只读");
	});
	function sessionNameInputs(): HTMLInputElement[] {
		return Array.from(document.querySelectorAll("label"))
			.filter((label) => label.textContent === "会话名称（可选）")
			.map((label) => document.getElementById(label.htmlFor))
			.filter((input): input is HTMLInputElement => input instanceof HTMLInputElement);
	}
	async function sessionName(value: string) {
		await act(async () => {
			const input = sessionNameInputs()[0];
			if (!input) throw new Error("缺少会话名称");
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	it("Peer 与 By the way 的 Plan 偏好、名称与正文草稿各自隔离", async () => {
		await open();
		await text("Peer 正文");
		await sessionName("Peer 主题");
		await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click());
		await role("by_the_way");
		expect(sessionNameInputs()).toHaveLength(1);
		expect(sessionNameInputs()[0]?.value).toBe("");
		expect(document.querySelector("textarea")?.value).toBe("");
		expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
		await text("侧问正文");
		await role("task_collaborator");
		expect(sessionNameInputs()).toHaveLength(1);
		expect(sessionNameInputs()[0]?.value).toBe("Peer 主题");
		expect(document.querySelector("textarea")?.value).toBe("Peer 正文");
		expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
	});
	it("确定未创建的失败保留输入并允许修正；响应未知跨关闭后核验原冻结请求", async () => {
		const value = target();
		await open(value);
		await text("保留原输入");
		await click("创建会话");
		expect(document.querySelector("textarea")?.value).toBe("保留原输入");
		expect(document.querySelector("fieldset")?.disabled).toBe(false);
		vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mockRejectedValueOnce(
			new Error("响应丢失"),
		);
		await click("创建会话");
		const frozen = vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mock.calls.at(-1)?.[1];
		await act(async () => closeSideSessionCreationWorkbench());
		await open({ ...value, agentId: "claude" });
		expect(creationQueries.submitOrRecoverTaskConversationSessionCreation).toHaveBeenLastCalledWith(
			"project-a",
			frozen,
		);
	});
	function creationResult(
		status: "started" | "reserved" | "awaiting_startup_evidence" | "execution_prohibited" | "failed",
		notice: string | null,
	) {
		return {
			ok: true as const,
			creation: {
				requestId: "request",
				taskId: "abcde",
				taskIncarnationCreatedAt: 1,
				taskConversationSessionId: "session",
				creatorTaskConversationSessionId: "abcde",
				contextSourceTaskConversationSessionId: "abcde",
				createdAt: 1,
				status,
				notice,
				unchangedEvidenceProbeCount: 0,
				nextEvidenceProbeAt: null,
			},
			summary: null,
		};
	}
	it("明确未启动的禁止结果释放草稿，并允许用新的幂等身份再创建", async () => {
		vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mockResolvedValueOnce(
			creationResult("execution_prohibited", "宿主任务已停止，原会话未启动。"),
		);
		await open();
		await text("仍可修正");
		await click("创建会话");
		expect(document.querySelector("textarea")?.value).toBe("仍可修正");
		expect(document.querySelector("fieldset")?.disabled).toBe(false);
		expect(document.body.textContent).toContain("宿主任务已停止，原会话未启动。");
		const blocked = vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mock.calls.at(-1)?.[1];
		vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mockResolvedValueOnce({
			ok: false,
			creation: null,
			summary: null,
			error: "先停在这一步",
		});
		await click("创建会话");
		const retried = vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mock.calls.at(-1)?.[1];
		expect(retried?.initialMessage).toBe("仍可修正");
		expect(retried?.idempotencyKey).not.toBe(blocked?.idempotencyKey);
	});
	it.each(["reserved", "awaiting_startup_evidence"] as const)(
		"%s 不关闭窗口、不删除输入，并在重新打开时核验同一提交",
		async (status) => {
			const onCreated = vi.fn();
			vi.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation).mockResolvedValue(
				creationResult(status, "启动结果尚未确认。"),
			);
			const value = target();
			await open({ ...value, onCreated });
			await text("必须留下");
			await click("创建会话");
			expect(onCreated).not.toHaveBeenCalled();
			expect(document.querySelector('[role="dialog"]')).not.toBeNull();
			expect(document.querySelector("textarea")?.value).toBe("必须留下");
			expect(document.querySelector("fieldset")?.disabled).toBe(true);
			const frozen = vi
				.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation)
				.mock.calls.at(-1)?.[1];
			await act(async () => closeSideSessionCreationWorkbench());
			await open(value);
			expect(creationQueries.submitOrRecoverTaskConversationSessionCreation).toHaveBeenLastCalledWith(
				"project-a",
				frozen,
			);
		},
	);
	it("By the way 不展示无法只读创建的 Agent", async () => {
		await open();
		expect(document.querySelector('[aria-label="Oh My Pi (omp)"]')).not.toBeNull();
		await role("by_the_way");
		expect(document.querySelector('[aria-label="Oh My Pi (omp)"]')).toBeNull();
		expect(document.querySelector('[aria-label="Claude Code"]')).not.toBeNull();
	});
	it("服务端 Plan 偏好晚到时补齐尚未改过 Plan 的新草稿", async () => {
		let releaseConfig: (config: RuntimeConfigResponse) => void = () => undefined;
		vi.spyOn(configQueries, "fetchRuntimeConfig").mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseConfig = resolve;
				}),
		);
		startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
		await open();
		expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
		await act(async () => {
			releaseConfig({
				userInterfacePreferencesSharedAcrossBrowserOrigins: {
					...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					newPeerSessionStartInPlanMode: true,
				},
			} as RuntimeConfigResponse);
		});
		expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
	});
	it("已经保存的草稿不因随后到达的 Plan 偏好被改写", async () => {
		await open();
		await text("已经保存的草稿");
		await act(async () => closeSideSessionCreationWorkbench());
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
		let releaseConfig: (config: RuntimeConfigResponse) => void = () => undefined;
		vi.spyOn(configQueries, "fetchRuntimeConfig").mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseConfig = resolve;
				}),
		);
		startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
		await open();
		await act(async () => {
			releaseConfig({
				userInterfacePreferencesSharedAcrossBrowserOrigins: {
					...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					newPeerSessionStartInPlanMode: true,
				},
			} as RuntimeConfigResponse);
		});
		expect(document.querySelector("textarea")?.value).toBe("已经保存的草稿");
		expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
	});
	it("切换创建类型后，迟到的图片仍写回发起时的草稿", async () => {
		let finishRead: (image: Awaited<ReturnType<typeof imageUtils.fileToTaskImage>>) => void = () => undefined;
		vi.spyOn(imageUtils, "fileToTaskImage").mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRead = resolve;
				}),
		);
		await open();
		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (!fileInput) throw new Error("缺少图片输入");
		const file = new File(["png"], "peer-reference.png", { type: "image/png" });
		await act(async () => {
			Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
			fileInput.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await role("by_the_way");
		await act(async () => {
			finishRead({ id: "img1", data: "abc", mimeType: "image/png", name: "peer-reference.png" });
		});
		await click("创建会话");
		const submitted = vi
			.mocked(creationQueries.submitOrRecoverTaskConversationSessionCreation)
			.mock.calls.at(-1)?.[1];
		expect(submitted?.sessionRole).toBe("by_the_way");
		expect(submitted?.images ?? []).toEqual([]);
		await role("task_collaborator");
		expect(document.body.textContent).toContain("peer-reference.png");
	});
	it("关闭后重开同一草稿时，迟到图片并入当前正文，不再回写关闭前快照", async () => {
		let finishRead: (image: Awaited<ReturnType<typeof imageUtils.fileToTaskImage>>) => void = () => undefined;
		vi.spyOn(imageUtils, "fileToTaskImage").mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRead = resolve;
				}),
		);
		const value = target();
		await open(value);
		await text("关闭前正文");
		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (!fileInput) throw new Error("缺少图片输入");
		const file = new File(["png"], "peer-reference.png", { type: "image/png" });
		await act(async () => {
			Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
			fileInput.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => closeSideSessionCreationWorkbench());
		await open(value);
		expect(document.querySelector("textarea")?.value).toBe("关闭前正文");
		await text("重开后编辑的新正文");
		await act(async () => {
			finishRead({ id: "img1", data: "abc", mimeType: "image/png", name: "peer-reference.png" });
		});
		const saved = readActiveSideSessionCreationDraft(value, "task_collaborator");
		expect(saved?.request.initialMessage).toBe("重开后编辑的新正文");
		expect(saved?.request.images?.map((image) => image.name)).toEqual(["peer-reference.png"]);
		expect(document.querySelector("textarea")?.value).toBe("重开后编辑的新正文");
		expect(document.body.textContent).toContain("peer-reference.png");
		await text("再次编辑");
		const afterEdit = readActiveSideSessionCreationDraft(value, "task_collaborator");
		expect(afterEdit?.request.initialMessage).toBe("再次编辑");
		expect(afterEdit?.request.images?.map((image) => image.name)).toEqual(["peer-reference.png"]);
	});
	it("不同项目或同 ID 的新 incarnation 不取得原草稿", async () => {
		const value = target();
		await open(value);
		await text("项目 A 原任务草稿");
		await act(async () => closeSideSessionCreationWorkbench());
		await open({ ...value, workspaceId: "project-b" });
		expect(document.querySelector("textarea")?.value).toBe("");
		await act(async () => closeSideSessionCreationWorkbench());
		await open({ ...value, task: { ...value.task, createdAt: 2 } });
		expect(document.querySelector("textarea")?.value).toBe("");
	});
});
