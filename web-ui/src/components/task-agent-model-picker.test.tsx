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
} from "@/runtime/types";

const fetchClineProviderCatalogMock = vi.hoisted(() => vi.fn());
const fetchClineProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
	]),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderCatalog: fetchClineProviderCatalogMock,
	fetchClineProviderModels: fetchClineProviderModelsMock,
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
	vi.restoreAllMocks();
});

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
