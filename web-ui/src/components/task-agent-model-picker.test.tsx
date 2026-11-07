import { act, type ReactElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	TaskAgentModelPicker,
	type UseTaskAgentModelPickerResult,
	useTaskAgentModelPicker,
} from "@/components/task-agent-model-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { notifyCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import type { RuntimeAgentId, RuntimeTaskTerminalAgentModelOverrideSettings } from "@/runtime/types";
import { notifyTaskVisualizationStreamReconnected } from "@/stores/task-visualization-browser-bridge";

const fetchTerminalAgentModelSelectionOptionsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID: "cursor-grok-4.6-high",
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "codex", label: "Codex", binary: "codex" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
		{ id: "cursor", label: "Cursor", binary: "cursor-agent" },
	]),
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) =>
		agentId === "claude"
			? { id: "claude", label: "Claude Code", installUrl: "https://install.example/claude" }
			: null,
	),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchTerminalAgentModelSelectionOptions: fetchTerminalAgentModelSelectionOptionsMock,
}));

function findButtonByAriaLabel(label: string): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function renderWithTooltipProvider(element: ReactElement): void {
	root.render(<TooltipProvider>{element}</TooltipProvider>);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.localStorage.clear();
	vi.restoreAllMocks();
});

const TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX = "kanban:task-agent-model-cache:";

function seedTaskAgentModelListCache(key: string, value: unknown): void {
	window.localStorage.setItem(TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX + key, JSON.stringify(value));
}

function readTaskAgentModelListCacheRaw(key: string): string | null {
	return window.localStorage.getItem(TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX + key);
}

describe("TaskAgentModelPicker – agent icon selector", () => {
	it("renders agent icon buttons immediately without the old override foldout", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={() => {}}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "claude", label: "Claude Code" },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		expect(container.textContent).not.toContain("Override Agent Settings");
		const inheritedDefaultAgentButton = findButtonByAriaLabel("Codex (default agent)");
		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		expect(claudeAgentButton).not.toBeNull();
		expect(inheritedDefaultAgentButton?.getAttribute("aria-pressed")).toBe("true");
		expect(claudeAgentButton?.getAttribute("aria-pressed")).toBe("false");
	});

	it("选择显式 Agent", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "claude", label: "Claude Code" },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(claudeAgentButton).not.toBeNull();
		await act(async () => {
			claudeAgentButton?.click();
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("claude");
	});

	it("再次点击已继承的默认 Agent 不重复提交", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "claude", label: "Claude Code" },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const inheritedDefaultAgentButton = findButtonByAriaLabel("Codex (default agent)");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		expect(inheritedDefaultAgentButton?.getAttribute("aria-pressed")).toBe("true");
		await act(async () => {
			inheritedDefaultAgentButton?.click();
		});

		expect(onAgentIdChange).not.toHaveBeenCalled();
	});

	it("selects the inherited default agent as an undefined task override", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"claude" as RuntimeAgentId}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "claude", label: "Claude Code" },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		expect(container.textContent).not.toContain("Provider");
		const inheritedDefaultAgentButton = findButtonByAriaLabel("Codex (default agent)");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		await act(async () => {
			inheritedDefaultAgentButton?.click();
		});

		expect(onAgentIdChange).toHaveBeenCalledWith(undefined);
	});
});

describe("TaskAgentModelPicker – terminal agent model selector", () => {
	it("shows Cursor's Kanban default as the non-fast Grok high tier", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cursor" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					terminalAgentModelOverrideSettings={undefined}
					onTerminalAgentModelOverrideSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "cursor", label: "Cursor" },
					]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
						{ value: "cursor-grok-4.6-high-fast", label: "Cursor Grok 4.6 Fast" },
					]}
					isLoadingTerminalAgentModels={false}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		expect(findButtonByAriaLabel("Default · Cursor Grok 4.6")).not.toBeNull();
		expect(container.textContent).not.toContain("Default · Cursor Grok 4.6 Fast");
	});

	it("writes an explicit terminal agent model override when a non-default model is selected", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onTerminalAgentModelOverrideSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cursor" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					terminalAgentModelOverrideSettings={undefined}
					onTerminalAgentModelOverrideSettingsChange={onTerminalAgentModelOverrideSettingsChange}
					agentOptions={[
						{ value: "", label: "Codex" },
						{ value: "cursor", label: "Cursor" },
					]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
					]}
					isLoadingTerminalAgentModels={false}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const autoButton = findButtonByAriaLabel("Auto");
		expect(autoButton).not.toBeNull();
		await act(async () => {
			autoButton?.click();
		});

		expect(onTerminalAgentModelOverrideSettingsChange).toHaveBeenCalledWith({
			agentId: "cursor",
			modelId: "auto",
		});
	});
});

describe("TaskAgentModelPicker – not-installed agent grey-out", () => {
	it("greys out a not-installed agent and opens the install guide on click instead of selecting it", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();
		const openMock = vi.spyOn(window, "open").mockReturnValue(null);

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex", installed: true },
						{ value: "claude", label: "Claude Code", installed: false },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(claudeAgentButton).not.toBeNull();
		// Grey base treatment for not-installed agents.
		expect(claudeAgentButton?.className).toContain("opacity-50");
		expect(claudeAgentButton?.className).toContain("cursor-default");

		await act(async () => {
			claudeAgentButton?.click();
		});

		// Click opens the install guide and does NOT select the agent.
		expect(openMock).toHaveBeenCalledWith("https://install.example/claude", "_blank", "noopener,noreferrer");
		expect(onAgentIdChange).not.toHaveBeenCalled();
	});

	it("does not grey out an installed agent and selects it on click", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();
		const openMock = vi.spyOn(window, "open").mockReturnValue(null);

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex", installed: true },
						{ value: "claude", label: "Claude Code", installed: true },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(claudeAgentButton?.className).not.toContain("opacity-50");

		await act(async () => {
			claudeAgentButton?.click();
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("claude");
		expect(openMock).not.toHaveBeenCalled();
	});

	it("keeps a selected-but-not-installed agent greyed out instead of showing the accent selected state", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					// Editing a task whose saved agentId points at an agent whose binary isn't installed:
					// the option is both selected AND installed: false.
					agentId={"claude" as RuntimeAgentId}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Codex", installed: true },
						{ value: "claude", label: "Claude Code", installed: false },
					]}
					defaultAgentId={"codex" as RuntimeAgentId}
				/>,
			),
		);

		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(claudeAgentButton).not.toBeNull();
		// aria-pressed still reflects the real selection state.
		expect(claudeAgentButton?.getAttribute("aria-pressed")).toBe("true");
		// The not-installed grey-out must win over the accent selected style, since a
		// not-installed agent can't be used — clicking only opens the install guide.
		expect(claudeAgentButton?.className).toContain("opacity-50");
		expect(claudeAgentButton?.className).toContain("cursor-default");
		expect(claudeAgentButton?.className).not.toContain("border-accent");
	});
});

describe("useTaskAgentModelPicker – installed + terminal model description passthrough", () => {
	it("依据检测结果展示安装状态，旧 Cline 不进入选项", async () => {
		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				agents: [
					{
						id: "claude",
						label: "Claude Code",
						binary: "claude",
						command: "claude",
						defaultArgs: [],
						installed: false,
						configured: false,
					},
				],
				defaultAgentId: "cline",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => renderWithTooltipProvider(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		const installedByValue = new Map(snapshot!.agentOptions.map((o) => [o.value, o.installed]));
		// 退役默认值没有可执行安装状态。
		expect(installedByValue.get("")).toBeNull();
		expect(installedByValue.has("cline")).toBe(false);
		// Backend-detected not-installed agent.
		expect(installedByValue.get("claude")).toBe(false);
		// An agent absent from the agents input → unknown (null), renders normally.
		expect(installedByValue.get("cursor")).toBeNull();
	});

	it("carries the concrete model-id description and selection group through terminalAgentModelOptions", async () => {
		fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue({
			agentId: "claude",
			defaultModelId: null,
			defaultLabel: "Default",
			options: [
				{
					modelId: "opus",
					label: "Opus",
					description: "--model opus · latest Opus",
					modelSelectionGroup: "latest_tracking_alias",
				},
				{
					modelId: "claude-opus-4-8",
					label: "Opus 4.8",
					description: "claude-opus-4-8 · previous Opus version",
					modelSelectionGroup: "pinned_version",
				},
			],
		});

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "claude",
				defaultAgentId: "cline",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => renderWithTooltipProvider(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		const byValue = new Map(snapshot!.terminalAgentModelOptions.map((o) => [o.value, o]));
		expect(byValue.get("opus")).toEqual({
			value: "opus",
			label: "Opus",
			description: "--model opus · latest Opus",
			modelSelectionGroup: "latest_tracking_alias",
		});
		expect(byValue.get("claude-opus-4-8")).toEqual({
			value: "claude-opus-4-8",
			label: "Opus 4.8",
			description: "claude-opus-4-8 · previous Opus version",
			modelSelectionGroup: "pinned_version",
		});
		// The synthetic "Default" placeholder belongs to the always-visible alias row.
		expect(byValue.get("")?.modelSelectionGroup).toBe("latest_tracking_alias");
	});
});

describe("useTaskAgentModelPicker – terminal agent model cache staleness", () => {
	async function renderTerminalAgentHarness(agentId: RuntimeAgentId): Promise<UseTaskAgentModelPickerResult> {
		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId,
				defaultAgentId: "cline",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => renderWithTooltipProvider(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		return snapshot!;
	}

	it("discards a cache written before modelSelectionGroup instead of re-showing its mislabeled options", async () => {
		// 升级前写下的响应：`opus` 的 label 钉着 "Opus 4.8"，而 `--model opus` 实跑的是最新 Opus。
		// 整份缓存都没有 modelSelectionGroup —— 这正是「写于本字段引入之前」的指纹。
		seedTaskAgentModelListCache("terminal:claude", {
			agentId: "claude",
			defaultModelId: null,
			defaultLabel: "Default",
			options: [
				{ modelId: "opus", label: "Opus 4.8", description: "claude-opus-4-8" },
				{ modelId: "sonnet", label: "Sonnet 4.6", description: "claude-sonnet-4-6" },
			],
		});
		// 后端 `claude --help` 探测失败会 resolve 成带 warning 的降级响应而非 reject。修复前这条路径
		// 会因「已有缓存」而短路，于是错标列表跨会话永久留存；现在旧缓存已被判成 cache miss，降级响应
		// 会被 apply 出来，界面立刻退回 Default 而不是继续说谎。
		fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue({
			agentId: "claude",
			defaultModelId: null,
			defaultLabel: "Default",
			options: [],
			warning: "claude --help failed",
		});

		const snapshot = await renderTerminalAgentHarness("claude");

		expect(snapshot.terminalAgentModelOptions.map((option) => option.label)).toEqual(["Default"]);
		expect(snapshot.terminalAgentModelOptions.some((option) => option.label.includes("4.8"))).toBe(false);
		// 降级响应绝不能落盘，否则会把好端端的列表污染成单条 Default 并跨会话持久化。
		expect(readTaskAgentModelListCacheRaw("terminal:claude")).toContain("Opus 4.8");
	});

	it("still seeds an agent whose options are all latest-tracking aliases (cursor / codex regression guard)", async () => {
		// 回归陷阱：若判据写成「存在某条缺分档 ⇒ 过期」或「必须有 pinned_version ⇒ 才算新」，
		// cursor / codex 这种整份都只有别名档的响应就会被永久判成过期、缓存再也 seed 不了。
		seedTaskAgentModelListCache("terminal:cursor", {
			agentId: "cursor",
			defaultModelId: "cursor-grok-4.6-high",
			defaultLabel: "Default · Cursor Grok 4.6",
			options: [
				{ modelId: "auto", label: "Auto", modelSelectionGroup: "latest_tracking_alias" },
				{
					modelId: "cursor-grok-4.6-high-fast",
					label: "Cursor Grok 4.6 Fast",
					modelSelectionGroup: "latest_tracking_alias",
				},
			],
		});
		// 探测失败时保留缓存列表，才能证明下面这些选项确实来自 seed 而不是本次请求。
		fetchTerminalAgentModelSelectionOptionsMock.mockRejectedValue(new Error("cursor-agent missing"));

		const snapshot = await renderTerminalAgentHarness("cursor");

		expect(snapshot.terminalAgentModelOptions.map((option) => option.label)).toEqual([
			"Default · Cursor Grok 4.6",
			"Auto",
			"Cursor Grok 4.6 Fast",
		]);
		expect(snapshot.terminalAgentDefaultModelId).toBe("cursor-grok-4.6-high");
	});

	it("Kimi 默认自动跟随与固定当前版本保留为两个独立选择", async () => {
		fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue({
			agentId: "kimi",
			defaultModelId: "kimi-code/k3.1-pro",
			defaultLabel: "默认 · K3.1 Pro",
			options: [{ modelId: "kimi-code/k3.1-pro", label: "K3.1 Pro", modelSelectionGroup: "pinned_version" }],
		});
		const snapshot = await renderTerminalAgentHarness("kimi");
		expect(snapshot.terminalAgentModelOptions.map((option) => option.value)).toEqual(["", "kimi-code/k3.1-pro"]);
		expect(snapshot.terminalAgentDefaultModelId).toBe("kimi-code/k3.1-pro");
	});
});

describe("Kimi 固定当前默认版本的展示", () => {
	it("已有固定版本不被显示成自动跟随，固定版本组自动展开", async () => {
		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId="kimi"
					onAgentIdChange={() => {}}
					terminalAgentModelOverrideSettings={{ agentId: "kimi", modelId: "kimi-code/k3.1-pro" }}
					terminalAgentDefaultModelId="kimi-code/k3.1-pro"
					terminalAgentModelOptions={[
						{ value: "", label: "默认 · K3.1 Pro", modelSelectionGroup: "latest_tracking_alias" },
						{ value: "kimi-code/k3.1-pro", label: "K3.1 Pro", modelSelectionGroup: "pinned_version" },
					]}
					agentOptions={[]}
				/>,
			),
		);
		expect(findButtonByAriaLabel("K3.1 Pro")?.getAttribute("aria-pressed")).toBe("true");
		expect(findButtonByAriaLabel("默认 · K3.1 Pro")?.getAttribute("aria-pressed")).toBe("false");
	});
});

describe("Codex 钉选与原生默认同名的模型", () => {
	it("已钉选的同名模型不被显示成不传 --model 的 Default", async () => {
		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId="codex"
					onAgentIdChange={() => {}}
					terminalAgentModelOverrideSettings={{ agentId: "codex", modelId: "gpt-5.4" }}
					terminalAgentDefaultModelId="gpt-5.4"
					terminalAgentModelOptions={[
						{ value: "", label: "Default", modelSelectionGroup: "latest_tracking_alias" },
						{ value: "gpt-5.4", label: "GPT-5.4", modelSelectionGroup: "latest_tracking_alias" },
					]}
					agentOptions={[]}
				/>,
			),
		);
		expect(findButtonByAriaLabel("GPT-5.4")?.getAttribute("aria-pressed")).toBe("true");
		expect(findButtonByAriaLabel("Default")?.getAttribute("aria-pressed")).toBe("false");
	});
});

describe("TaskAgentModelPicker – pinned model version group", () => {
	const CLAUDE_TERMINAL_MODEL_OPTIONS = [
		{ value: "", label: "Default", modelSelectionGroup: "latest_tracking_alias" as const },
		{ value: "opus", label: "Opus", modelSelectionGroup: "latest_tracking_alias" as const },
		{ value: "claude-opus-4-8", label: "Opus 4.8", modelSelectionGroup: "pinned_version" as const },
	];

	async function renderClaudeModelPicker(
		terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings,
	) {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"claude" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					defaultAgentId={"claude" as RuntimeAgentId}
					terminalAgentModelOverrideSettings={terminalAgentModelOverrideSettings}
					onTerminalAgentModelOverrideSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Claude Code" }]}
					terminalAgentModelOptions={CLAUDE_TERMINAL_MODEL_OPTIONS}
				/>,
			),
		);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
	}

	it("hides pinned versions behind a collapsed trigger while alias options stay visible", async () => {
		await renderClaudeModelPicker();

		expect(findButtonByAriaLabel("Opus")).not.toBeNull();
		expect(container.textContent).toContain("Pinned versions (1)");
		// Radix keeps a collapsed Content unmounted, so the pinned chip must not be in the DOM at all.
		expect(findButtonByAriaLabel("Opus 4.8")).toBeNull();
	});

	it("auto-expands the group when the selected model is a pinned version", async () => {
		// Otherwise the selected chip lives inside a collapsed section and the selection looks lost.
		await renderClaudeModelPicker({ agentId: "claude", modelId: "claude-opus-4-8" });

		const pinnedOptionButton = findButtonByAriaLabel("Opus 4.8");
		expect(pinnedOptionButton).not.toBeNull();
		expect(pinnedOptionButton?.getAttribute("aria-pressed")).toBe("true");
	});
});

// 后端按「每条产品线只显示最新一代」收窄了列表，钉在旧代次上的卡片一定落在列表之外。
// claude 侧靠 pinned 折叠区自动展开解决了同类问题，cursor / codex / kimi 没有对应机制。
describe("TaskAgentModelPicker – selected model that is no longer listed", () => {
	async function renderCursorModelPicker(
		terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings,
	) {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cursor" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					defaultAgentId={"cursor" as RuntimeAgentId}
					terminalAgentModelOverrideSettings={terminalAgentModelOverrideSettings}
					onTerminalAgentModelOverrideSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Cursor" }]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
						{ value: "cursor-grok-4.6-xhigh", label: "Cursor Grok 4.6 Extra High" },
					]}
				/>,
			),
		);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
	}

	it("keeps a chip for a pinned older-generation model that the latest-generation list no longer offers", async () => {
		await renderCursorModelPicker({ agentId: "cursor", modelId: "cursor-grok-4.5-high" });

		const preservedSelectionButton = findButtonByAriaLabel("cursor-grok-4.5-high");
		expect(preservedSelectionButton).not.toBeNull();
		expect(preservedSelectionButton?.getAttribute("aria-pressed")).toBe("true");
	});

	it("adds no extra chip when the selection is already in the list", async () => {
		await renderCursorModelPicker({ agentId: "cursor", modelId: "cursor-grok-4.6-xhigh" });

		expect(container.querySelectorAll('[aria-label="Agent model"] button')).toHaveLength(3);
		expect(findButtonByAriaLabel("Cursor Grok 4.6 Extra High")?.getAttribute("aria-pressed")).toBe("true");
	});
});

describe("Codex 模型目录在运行时重连后重验", () => {
	it("三次重试耗尽后，运行时或可视化流重连会再次读取目录", async () => {
		vi.useFakeTimers();
		const unavailable = {
			agentId: "codex" as const,
			defaultModelId: null,
			defaultLabel: "Default",
			options: [],
			warning: "目录暂不可读",
		};
		const available = {
			agentId: "codex" as const,
			defaultModelId: "native-default",
			defaultLabel: "Default",
			options: [
				{
					modelId: "native-default",
					label: "原生模型",
					supportedReasoningEfforts: [{ effort: "ultra" }],
					modelSelectionGroup: "latest_tracking_alias" as const,
				},
			],
		};
		fetchTerminalAgentModelSelectionOptionsMock.mockClear();
		fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue(unavailable);
		let latest: UseTaskAgentModelPickerResult | undefined;
		function Harness() {
			latest = useTaskAgentModelPicker({
				active: true,
				workspaceId: "reviewer-workspace",
				agentId: "codex",
			});
			return null;
		}
		try {
			await act(async () => {
				root.render(<Harness />);
			});
			for (const duration of [2_000, 4_000, 8_000]) {
				await act(async () => {
					await vi.advanceTimersByTimeAsync(duration);
				});
			}
			expect(fetchTerminalAgentModelSelectionOptionsMock).toHaveBeenCalledTimes(4);
			fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue(available);
			await act(async () => {
				notifyCodexConfigurationSyncUpdated("runtime_reconnected");
			});
			expect(fetchTerminalAgentModelSelectionOptionsMock).toHaveBeenCalledTimes(5);
			expect(latest?.terminalAgentModelCatalogWarning).toBeNull();
			fetchTerminalAgentModelSelectionOptionsMock.mockResolvedValue(unavailable);
			await act(async () => {
				notifyTaskVisualizationStreamReconnected("reviewer-workspace");
			});
			expect(fetchTerminalAgentModelSelectionOptionsMock).toHaveBeenCalledTimes(6);
			expect(latest?.terminalAgentModelCatalogWarning).toBe(unavailable.warning);
		} finally {
			vi.useRealTimers();
		}
	});
});
