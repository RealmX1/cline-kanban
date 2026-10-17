import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskConversationSessionsPanel } from "@/components/detail-panels/task-conversation-sessions-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const ORIGINAL_PROMPT_CARD = {
	title: "Build sessions",
	prompt: "Build sessions end to end.",
	images: undefined,
	createdAt: 1,
};

function createSessionSummary(
	taskId: string,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		...overrides,
	};
}

// 真实应用把 TooltipProvider 挂在 main.tsx 的根上（Radix 的 Tooltip 没有 Provider 会直接抛），
// 这里照同一个形态包裹整个 root，而不是给每一处 render 各加一层。
function createRootRenderingInsideTooltipProvider(mountContainer: HTMLElement): Root {
	const reactRoot = createRoot(mountContainer);
	return {
		...reactRoot,
		render: (children: React.ReactNode) => reactRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => reactRoot.unmount(),
	};
}

describe("TaskConversationSessionsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRootRenderingInsideTooltipProvider(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows relationships and persists an answer as read when selected", async () => {
		const mainSessionSummary = createSessionSummary("task-1", {
			latestTurnCheckpoint: { commit: "abc", ref: "HEAD", turn: 5, createdAt: 5 },
		});
		const sideSessionSummary = createSessionSummary("side-1", {
			updatedAt: 20,
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 3,
				mainSessionOriginUserMessagePreview: "Build sessions",
				latestUserMessagePreview: "Why is this read-only?",
			},
		});
		const onSelectTaskConversationSession = vi.fn();

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary, "side-1": sideSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={onSelectTaskConversationSession}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		expect(container.textContent).toContain("Why is this read-only?");
		expect(container.textContent).toContain("Forked from main · 2 turns ago");
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();

		const sideSessionButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Why is this read-only?"),
		);
		await act(async () => sideSessionButton?.click());

		expect(onSelectTaskConversationSession).toHaveBeenCalledWith("side-1");
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toMatchObject({ "side-1": 20 });
	});

	it("creates a fork of the current main session from the Add New form", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		const onCreateTaskConversationSession = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={onCreateTaskConversationSession}
				/>,
			);
		});

		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click();
		});
		await act(async () => {
			const roleSelect = container.querySelector<HTMLSelectElement>("#task-conversation-session-role");
			if (roleSelect) {
				roleSelect.value = "by_the_way";
				roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		const questionInput = container.querySelector("textarea");
		expect(questionInput).toBeInstanceOf(HTMLTextAreaElement);
		await act(async () => {
			if (!questionInput) return;
			const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(questionInput, "Explain the relation");
			questionInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const createSessionButtons = Array.from(container.querySelectorAll("button")).filter(
			(button) => button.textContent === "Create session",
		);
		await act(async () => createSessionButtons.at(-1)?.click());

		expect(onCreateTaskConversationSession).toHaveBeenCalledWith({
			agentId: "codex",
			sessionRole: "by_the_way",
			initialUserQuestion: "Explain the relation",
			contextSource: "forked_from_main_current_turn",
		});
	});

	it("协作会话可选择创建任务的全部 agent，使用全新上下文，失败后保留输入", async () => {
		const onCreateTaskConversationSession = vi.fn(async () => ({ ok: false, message: "隔离启动失败" }));
		await act(async () =>
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={createSessionSummary("task-1", { agentId: "claude" })}
					mainSessionUserMessagePreview="主任务"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="claude"
					taskSessions={{}}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={onCreateTaskConversationSession}
				/>,
			),
		);
		await act(async () =>
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click(),
		);
		const agentSelect = container.querySelector<HTMLSelectElement>("#task-conversation-session-agent");
		expect(Array.from(agentSelect?.options ?? []).map((option) => option.value)).toEqual(
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => agent.id),
		);
		expect(container.querySelector("#task-conversation-context-source")).toBeNull();
		await act(async () => {
			if (agentSelect) {
				agentSelect.value = "codex";
				agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
			const input = container.querySelector("textarea");
			Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
				input,
				"实现协作部分",
			);
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			Array.from(container.querySelectorAll("button"))
				.filter((button) => button.textContent === "Create session")
				.at(-1)
				?.click(),
		);
		expect(onCreateTaskConversationSession).toHaveBeenCalledWith({
			agentId: "codex",
			sessionRole: "task_collaborator",
			initialUserQuestion: "实现协作部分",
			contextSource: "started_from_scratch",
		});
		expect(container.textContent).toContain("隔离启动失败");
		expect(container.querySelector("textarea")?.value).toBe("实现协作部分");
	});

	it("未安装的 agent 显示原因，且不能提交创建", async () => {
		const onCreateTaskConversationSession = vi.fn(async () => ({ ok: true }));
		await act(async () =>
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={createSessionSummary("task-1")}
					mainSessionUserMessagePreview="主任务"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					agents={[
						{
							id: "codex",
							label: "OpenAI Codex",
							binary: "codex",
							command: "codex",
							defaultArgs: [],
							installed: false,
							configured: false,
						},
					]}
					taskSessions={{}}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={onCreateTaskConversationSession}
				/>,
			),
		);
		await act(async () =>
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click(),
		);
		expect(container.querySelector<HTMLOptionElement>('option[value="codex"]')?.disabled).toBe(true);
		expect(container.querySelector('option[value="codex"]')?.textContent).toContain("未安装");
		await act(async () => {
			const input = container.querySelector("textarea");
			Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(input, "协作工作");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submit = Array.from(container.querySelectorAll("button"))
			.filter((button) => button.textContent === "Create session")
			.at(-1);
		expect(submit?.disabled).toBe(true);
		await act(async () => submit?.click());
		expect(onCreateTaskConversationSession).not.toHaveBeenCalled();
	});

	it("disables By the way session creation for unsupported agents", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="gemini"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		expect(
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Add New"))
				?.disabled,
		).toBe(false);
	});

	it.each(
		(["claude", "codex"] as const).flatMap((mainAgentId) =>
			[true, false].flatMap((hasMainNativeIdentity) =>
				[true, false].map((hasSameAgentCollaborator) => ({
					mainAgentId,
					hasMainNativeIdentity,
					hasSameAgentCollaborator,
				})),
			),
		),
	)(
		"首次侧问 UI：$mainAgentId 主身份=$hasMainNativeIdentity，同 agent 协作=$hasSameAgentCollaborator",
		async ({ mainAgentId, hasMainNativeIdentity, hasSameAgentCollaborator }) => {
			const main = createSessionSummary("task-1", {
				agentId: mainAgentId,
				agentNativeConversationSessionIdentity: hasMainNativeIdentity
					? {
							sourceAgentId: mainAgentId,
							nativeSessionId: "11111111-2222-4333-8444-555555555555",
							transcriptPath: null,
							observedAt: 1,
						}
					: undefined,
			});
			const collaborator = createSessionSummary("collaborator", {
				agentId: hasSameAgentCollaborator ? mainAgentId : mainAgentId === "claude" ? "codex" : "claude",
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: "协作",
				},
			});
			await act(async () =>
				root.render(
					<TaskConversationSessionsPanel
						workspaceTaskId="task-1"
						mainSessionSummary={main}
						mainSessionUserMessagePreview="实现任务"
						mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
						effectiveAgentId={mainAgentId}
						taskSessions={{ "task-1": main, collaborator }}
						selectedTaskConversationSessionId="task-1"
						onSelectTaskConversationSession={() => {}}
						onCreateTaskConversationSession={async () => ({ ok: true })}
					/>,
				),
			);
			await act(async () =>
				Array.from(container.querySelectorAll("button"))
					.find((button) => button.textContent?.includes("Add New"))
					?.click(),
			);
			await act(async () => {
				const roleSelect = container.querySelector<HTMLSelectElement>("#task-conversation-session-role");
				if (!roleSelect) throw new Error("缺少角色选项");
				roleSelect.value = "by_the_way";
				roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
			});
			const mustRefuseAmbiguousFork = !hasMainNativeIdentity && hasSameAgentCollaborator;
			expect(
				container.querySelector<HTMLOptionElement>('option[value="forked_from_main_current_turn"]')?.disabled,
			).toBe(mustRefuseAmbiguousFork);
			if (mustRefuseAmbiguousFork) expect(container.textContent).toContain("主会话尚未记录可用的");
			expect(container.textContent).not.toContain("已有 By the way 会话");
		},
	);

	it("forces later By the way sessions to start from scratch", async () => {
		const mainSessionSummary = createSessionSummary("task-1");
		const existingByTheWaySummary = createSessionSummary("side-existing", {
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "Earlier question",
			},
		});
		const onCreateTaskConversationSession = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary, "side-existing": existingByTheWaySummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={onCreateTaskConversationSession}
				/>,
			);
		});

		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("Add New"))
				?.click();
		});
		await act(async () => {
			const roleSelect = container.querySelector<HTMLSelectElement>("#task-conversation-session-role");
			if (roleSelect) {
				roleSelect.value = "by_the_way";
				roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		const forkOption = container.querySelector<HTMLOptionElement>('option[value="forked_from_main_current_turn"]');
		expect(forkOption?.disabled).toBe(true);

		const questionInput = container.querySelector("textarea");
		await act(async () => {
			if (!questionInput) return;
			const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(questionInput, "Later question");
			questionInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.filter((button) => button.textContent === "Create session")
				.at(-1)
				?.click();
		});

		expect(onCreateTaskConversationSession).toHaveBeenCalledWith({
			agentId: "codex",
			sessionRole: "by_the_way",
			initialUserQuestion: "Later question",
			contextSource: "started_from_scratch",
		});
	});

	// 用户要拿会话 id 去对照日志 / 转录文件名，「看得见」与「拿得走」是两件事。
	it("exposes both identifiers on every row and copies them on click", async () => {
		const mainSessionSummary = createSessionSummary("task-1", {
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "aaaaaaaa-1111-4111-8111-111111111111",
				transcriptPath: "/home/u/.claude/projects/x/aaaaaaaa-1111-4111-8111-111111111111.jsonl",
				observedAt: 5,
			},
		});
		const sideSessionSummary = createSessionSummary("task-conversation-session-9", {
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "Why read-only?",
			},
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "bbbbbbbb-2222-4222-8222-222222222222",
				transcriptPath: null,
				observedAt: 6,
			},
		});
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="claude"
					taskSessions={{ "task-1": mainSessionSummary, "task-conversation-session-9": sideSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		const copyButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
			button.getAttribute("aria-label")?.startsWith("Copy the "),
		);
		const copiedIdentifiers = copyButtons.map((button) => button.getAttribute("aria-label"));
		// 两行 × 两个 id：会话 id 与 agent 原生会话 id。
		expect(copiedIdentifiers).toEqual([
			"Copy the Session id task-1",
			"Copy the claude id aaaaaaaa-1111-4111-8111-111111111111",
			"Copy the Session id task-conversation-session-9",
			"Copy the claude id bbbbbbbb-2222-4222-8222-222222222222",
		]);

		await act(async () => copyButtons[3]?.click());
		expect(writeText).toHaveBeenCalledWith("bbbbbbbb-2222-4222-8222-222222222222");
	});

	// sidecar 缺席（Cline / ACP 会话、还没触发过 hook 的老数据）时不摆占位符：
	// 一个空壳只会让人以为「这条会话的 id 是空的」。
	it("omits the agent native session chip when no identity has been observed", async () => {
		const mainSessionSummary = createSessionSummary("task-1");

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		const copiedIdentifiers = Array.from(container.querySelectorAll("button"))
			.map((button) => button.getAttribute("aria-label"))
			.filter((label) => label?.startsWith("Copy the "));
		expect(copiedIdentifiers).toEqual(["Copy the Session id task-1"]);
	});
});
