import { act, type ReactElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskAgentModelPickerResult } from "@/components/task-agent-model-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	RuntimeAgentId,
	RuntimeClineProviderCatalogItem,
	RuntimeClineProviderModel,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
} from "@/runtime/types";

const fetchClineProviderCatalogMock = vi.hoisted(() => vi.fn());
const fetchClineProviderModelsMock = vi.hoisted(() => vi.fn());
const fetchTerminalAgentModelSelectionOptionsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID: "cursor-grok-4.6-high",
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
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
	fetchClineProviderCatalog: fetchClineProviderCatalogMock,
	fetchClineProviderModels: fetchClineProviderModelsMock,
	fetchTerminalAgentModelSelectionOptions: fetchTerminalAgentModelSelectionOptionsMock,
}));

function createProvider(
	id: string,
	name: string,
	enabled: boolean,
	defaultModelId: string | null = null,
): RuntimeClineProviderCatalogItem {
	return { id, name, oauthSupported: false, enabled, defaultModelId, baseUrl: null, supportsBaseUrl: false };
}

function createTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	return settings;
}

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

describe("useTaskAgentModelPicker – clineProviderOptions", () => {
	it("shows all providers except the default, regardless of enabled flag", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true),
			createProvider("openrouter", "OpenRouter", false),
			createProvider("anthropic", "Anthropic", false),
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
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
		const options = snapshot!.clineProviderOptions;
		expect(options[0]).toEqual({ value: "", label: "Cline" });
		const nonDefault = options.slice(1);
		expect(nonDefault).toEqual([
			{ value: "openrouter", label: "OpenRouter" },
			{ value: "anthropic", label: "Anthropic" },
		]);
	});
	it("excludes the default provider from the explicit list", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true),
			createProvider("anthropic", "Anthropic", true),
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: null,
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
		const options = snapshot!.clineProviderOptions;
		expect(options[0]).toEqual({ value: "", label: "Anthropic" });
		const values = options.slice(1).map((o) => o.value);
		expect(values).toContain("cline");
		expect(values).not.toContain("anthropic");
	});

	it("returns only the default option when catalog is empty", async () => {
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
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
		expect(snapshot!.clineProviderOptions).toEqual([{ value: "", label: "cline" }]);
	});
});

describe("useTaskAgentModelPicker – providerDefaultModels", () => {
	it("returns a map of provider ID → default model ID", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
			createProvider("openrouter", "OpenRouter", true), // no default model
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
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
		expect(snapshot!.providerDefaultModels).toEqual({
			anthropic: "claude-opus-4-20250514",
			groq: "llama-3.3-70b-versatile",
		});
	});
});

describe("useTaskAgentModelPicker – provider-aware model default label", () => {
	it("loads inherited models for managed OAuth providers and derives their catalog default model", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true, "cline-sonnet"),
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
		];
		const clineModels = [
			{ id: "cline-sonnet", name: "Cline Sonnet" },
			{ id: "cline-opus", name: "Cline Opus" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(clineModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
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

		expect(fetchClineProviderModelsMock).toHaveBeenCalledWith(null, "cline");
		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerModels).toEqual(clineModels);
		expect(snapshot!.effectiveDefaultModelId).toBe("cline-sonnet");
	});

	it("does not borrow the global default model for an overridden provider without a catalog default", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("custom", "Custom Provider", true),
		];
		const customModels = [{ id: "custom/model-a", name: "Model A" }];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(customModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: createTaskClineSettings({ providerId: "custom" }),
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
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
		expect(snapshot!.effectiveDefaultModelId).toBeNull();
		expect(snapshot!.clineModelOptions[0]).toEqual({ value: "", label: "Default" });
	});

	it("shows the selected provider's default model name when provider is overridden", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const groqModels = [
			{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
			{ id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(groqModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: createTaskClineSettings({ providerId: "groq" }), // explicit provider override to groq
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514", // global default is Anthropic's model
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
		// The first model option should show groq's default model, not the global Anthropic model
		const defaultOption = snapshot!.clineModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Llama 3.3 70B");
	});

	it("shows the global default model when no provider override is set", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const anthropicModels = [
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(anthropicModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined, // no provider override
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
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
		const defaultOption = snapshot!.clineModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Claude Opus 4");
	});
});

describe("TaskAgentModelPicker – auto-reset invalid model selection", () => {
	it("resets clineModelId to the first real model when the selected model is not in the options list", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Anthropic" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// The effect should have fired and selected the first real model
		expect(onClineSettingsChange).toHaveBeenCalledWith({
			providerId: "groq",
			modelId: "llama-3.3-70b-versatile",
		});
	});

	it("does not reset when the selected model exists in the options list", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "llama-3.3-70b-versatile",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Groq" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset while models are still loading", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Anthropic" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={true} // <-- still loading
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset when model options only contain the default placeholder (race condition guard)", async () => {
		const onClineSettingsChange = vi.fn();
		// Only the "Default" placeholder — real models haven't loaded yet
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "mixtral-8x7b-32768",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Groq" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false} // <-- false (initial state before fetch sets it to true)
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// Should NOT clear the model — the stale/empty options list should not trigger auto-correct
		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});
});

describe("TaskAgentModelPicker – agent icon selector", () => {
	it("renders agent icon buttons immediately without the old override foldout", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "claude", label: "Claude Code" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
				/>,
			),
		);

		expect(container.textContent).not.toContain("Override Agent Settings");
		const inheritedDefaultAgentButton = findButtonByAriaLabel("Cline (default agent)");
		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		expect(claudeAgentButton).not.toBeNull();
		expect(inheritedDefaultAgentButton?.getAttribute("aria-pressed")).toBe("true");
		expect(claudeAgentButton?.getAttribute("aria-pressed")).toBe("false");
	});

	it("selects an explicit non-Cline agent and clears Cline settings", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					clineSettings={createTaskClineSettings({ providerId: "cline", modelId: "openai/gpt-5.4" })}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "claude", label: "Claude Code" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
				/>,
			),
		);

		const claudeAgentButton = findButtonByAriaLabel("Claude Code");
		expect(claudeAgentButton).not.toBeNull();
		await act(async () => {
			claudeAgentButton?.click();
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("claude");
		expect(onClineSettingsChange).toHaveBeenCalledWith(undefined);
	});

	it("does not clear Cline settings when the selected inherited default agent is clicked again", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					clineSettings={createTaskClineSettings({ providerId: "cline", modelId: "openai/gpt-5.4" })}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "claude", label: "Claude Code" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
				/>,
			),
		);

		const inheritedDefaultAgentButton = findButtonByAriaLabel("Cline (default agent)");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		expect(inheritedDefaultAgentButton?.getAttribute("aria-pressed")).toBe("true");
		await act(async () => {
			inheritedDefaultAgentButton?.click();
		});

		expect(onAgentIdChange).not.toHaveBeenCalled();
		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});

	it("selects the inherited default agent as an undefined task override", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onAgentIdChange = vi.fn();
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"claude" as RuntimeAgentId}
					onAgentIdChange={onAgentIdChange}
					clineSettings={createTaskClineSettings({ providerId: "cline" })}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "claude", label: "Claude Code" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
				/>,
			),
		);

		expect(container.textContent).not.toContain("Provider");
		const inheritedDefaultAgentButton = findButtonByAriaLabel("Cline (default agent)");
		expect(inheritedDefaultAgentButton).not.toBeNull();
		await act(async () => {
			inheritedDefaultAgentButton?.click();
		});

		expect(onAgentIdChange).toHaveBeenCalledWith(undefined);
		expect(onClineSettingsChange).toHaveBeenCalledWith(undefined);
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
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					terminalAgentModelOverrideSettings={undefined}
					onTerminalAgentModelOverrideSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "cursor", label: "Cursor" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
						{ value: "cursor-grok-4.6-high-fast", label: "Cursor Grok 4.6 Fast" },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					isLoadingTerminalAgentModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
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
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					terminalAgentModelOverrideSettings={undefined}
					onTerminalAgentModelOverrideSettingsChange={onTerminalAgentModelOverrideSettingsChange}
					agentOptions={[
						{ value: "", label: "Cline" },
						{ value: "cursor", label: "Cursor" },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					isLoadingTerminalAgentModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
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
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Cline", installed: true },
						{ value: "claude", label: "Claude Code", installed: false },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
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
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Cline", installed: true },
						{ value: "claude", label: "Claude Code", installed: true },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
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
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "Cline", installed: true },
						{ value: "claude", label: "Claude Code", installed: false },
					]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
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
	it("derives agentOptions.installed from the agents input (cline forced true, unknown null)", async () => {
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
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
				defaultProviderId: "cline",
				defaultModelId: null,
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
		// Default option resolves to cline → always installed.
		expect(installedByValue.get("")).toBe(true);
		// Backend-detected not-installed agent.
		expect(installedByValue.get("claude")).toBe(false);
		// An agent absent from the agents input → unknown (null), renders normally.
		expect(installedByValue.get("cursor")).toBeNull();
	});

	it("carries the concrete model-id description and selection group through terminalAgentModelOptions", async () => {
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		fetchClineProviderModelsMock.mockResolvedValue([]);
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
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
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
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId,
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
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
					clineProviderOptions={[]}
					clineModelOptions={[]}
					terminalAgentModelOptions={CLAUDE_TERMINAL_MODEL_OPTIONS}
					isLoadingProviders={false}
					isLoadingModels={false}
					providerDefaultModels={{}}
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
					clineProviderOptions={[]}
					clineModelOptions={[]}
					terminalAgentModelOptions={[
						{ value: "", label: "Default · Cursor Grok 4.6" },
						{ value: "auto", label: "Auto" },
						{ value: "cursor-grok-4.6-xhigh", label: "Cursor Grok 4.6 Extra High" },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					providerDefaultModels={{}}
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

describe("TaskAgentModelPicker – inherited default reasoning effort", () => {
	it("shows reasoning metadata for an inherited default model and opens reasoning choices immediately", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		expect(container.textContent).toContain("GPT-5.4 (High)");

		const trigger = document.getElementById("cline-chat-model-picker");
		expect(trigger).not.toBeNull();
		await act(async () => {
			(trigger as HTMLElement).click();
		});

		expect(document.body.textContent).toContain("Reasoning effort");
	});

	it("retains inherited reasoning effort until model capability data is available", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		const renderPicker = async (providerModels: RuntimeClineProviderModel[]) => {
			await act(async () =>
				renderWithTooltipProvider(
					<TaskAgentModelPicker
						agentId={"cline" as RuntimeAgentId}
						onAgentIdChange={() => {}}
						clineSettings={undefined}
						onClineSettingsChange={() => {}}
						agentOptions={[{ value: "", label: "Cline" }]}
						clineProviderOptions={[{ value: "", label: "Cline" }]}
						clineModelOptions={[
							{ value: "", label: "GPT-5.4" },
							{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
						]}
						effectiveDefaultModelId="openai/gpt-5.4"
						providerModels={providerModels}
						isLoadingProviders={false}
						isLoadingModels={false}
						defaultAgentId={"cline" as RuntimeAgentId}
						defaultProviderId="cline"
						defaultReasoningEffort="high"
					/>,
				),
			);
		};

		await renderPicker([]);

		await renderPicker([
			{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
			{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
		]);

		expect(container.textContent).toContain("GPT-5.4 (High)");
	});

	it("persists a reasoning-only override when model stays on default", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const modelTrigger = document.getElementById("cline-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const lowReasoningButton = Array.from(document.querySelectorAll("button")).find((button) =>
			button.textContent?.trim().toLowerCase().startsWith("low"),
		);
		expect(lowReasoningButton).not.toBeUndefined();
		await act(async () => {
			(lowReasoningButton as HTMLButtonElement).click();
		});

		expect(onClineSettingsChange).toHaveBeenLastCalledWith({
			reasoningEffort: "low",
		});
	});

	it("persists an explicit default reasoning override when the task inherits a global reasoning effort", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const modelTrigger = document.getElementById("cline-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const defaultReasoningButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Default",
		);
		expect(defaultReasoningButton).not.toBeUndefined();
		await act(async () => {
			(defaultReasoningButton as HTMLButtonElement).click();
		});

		expect(onClineSettingsChange).toHaveBeenLastCalledWith({});
	});

	it("does not inherit the global reasoning effort for explicit task model overrides", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			renderWithTooltipProvider(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						modelId: "openai/gpt-5.3-codex",
					})}
					onClineSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		expect(container.textContent).toContain("GPT-5.3 Codex");
		expect(container.textContent).not.toContain("GPT-5.3 Codex (High)");
	});
});
