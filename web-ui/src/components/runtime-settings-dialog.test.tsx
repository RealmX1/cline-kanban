import type { ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSettingsDialog } from "@/components/runtime-settings-dialog";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";

/*
 * Radix Select depends on pointer-capture APIs that jsdom lacks.
 * Replace it with a minimal native <select> so the theme-picker tests
 * can exercise onValueChange without fighting jsdom limitations.
 */
const RadixSelectCtx = createContext<{
	value: string;
	onValueChange: (v: string) => void;
}>({ value: "", onValueChange: () => {} });

vi.mock("@radix-ui/react-select", () => ({
	Root: ({
		value,
		onValueChange,
		children,
	}: {
		value: string;
		onValueChange: (v: string) => void;
		children: ReactNode;
	}) => {
		const open = false;
		return (
			<RadixSelectCtx.Provider value={{ value, onValueChange }}>
				<div data-radix-select-root="" data-state={open ? "open" : "closed"} data-open-setter={String(open)}>
					{typeof children === "function" ? null : children}
				</div>
			</RadixSelectCtx.Provider>
		);
	},
	Trigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
		return (
			<button type="button" {...props} data-radix-select-trigger="">
				{children}
			</button>
		);
	},
	Value: ({ placeholder }: { placeholder?: string }) => {
		const ctx = useContext(RadixSelectCtx);
		return <span>{ctx.value || placeholder}</span>;
	},
	Icon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
	Content: ({ children }: { children: ReactNode }) => <div data-radix-select-content="">{children}</div>,
	ScrollUpButton: () => null,
	ScrollDownButton: () => null,
	Viewport: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Separator: () => <hr />,
	Item: ({ value, children, ...rest }: { value: string; children: ReactNode }) => {
		const ctx = useContext(RadixSelectCtx);
		return (
			<button
				type="button"
				role="option"
				aria-label={value}
				data-radix-select-item=""
				onClick={() => ctx.onValueChange(value)}
				{...rest}
			>
				{children}
			</button>
		);
	},
	ItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const notificationSettingsMocks = vi.hoisted(() => ({
	getSettings: vi.fn(),
	saveProvider: vi.fn(),
	saveSettings: vi.fn(),
	previewSpeech: vi.fn(),
}));
vi.mock("@/runtime/notification-intelligence-query", () => ({
	notificationIntelligenceClient: () => ({
		getSettings: { query: notificationSettingsMocks.getSettings },
		saveProvider: { mutate: notificationSettingsMocks.saveProvider },
		saveSettings: { mutate: notificationSettingsMocks.saveSettings },
		speechModels: { query: async () => [] },
	}),
}));
vi.mock("@/utils/notification-summary-speech", () => ({
	playNotificationSummarySpeech: notificationSettingsMocks.previewSpeech,
}));
const savedNotificationSettings = {
	assessmentEnabled: false,
	summaryLanguage: "zh-CN",
	fallbackAfterMinutes: 10,
	taskNameSuggestionBinding: null,
	notificationAssessmentBinding: null,
	notificationSpeechBinding: { modelProviderId: "saved-tts", modelId: "hexgrad/Kokoro-82M" },
	speechMode: "summary",
	speechProvider: "deepinfra",
	speechVoice: "af_heart",
	speechSpeed: 1,
	speechPitch: 1,
	speechVolume: 1,
	speechStyleInstruction: "",
};
const savedNotificationProviders = [
	{
		modelProviderId: "saved-text",
		displayName: "文本服务",
		providerProtocol: "openai_compatible",
		credentialSource: "environment",
		alibabaRegion: "beijing",
		credentialConfigured: true,
		credentialStatusMessage: null,
	},
	{
		modelProviderId: "saved-tts",
		displayName: "我的语音服务",
		providerProtocol: "deepinfra",
		credentialSource: "system_credential_store",
		alibabaRegion: "beijing",
		credentialConfigured: true,
		credentialStatusMessage: null,
	},
];

const resetLayoutCustomizationsMock = vi.hoisted(() => vi.fn());
const useRuntimeConfigSaveMock = vi.hoisted(() => vi.fn(async () => true));
const clineSetupSectionOnSavedRef = vi.hoisted(() => ({
	onSaved: null as null | (() => void),
}));

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => ({
		id: agentId,
		installUrl: null,
		baseArgs: [],
		autonomousArgs: [],
	})),
	getRuntimeAgentSessionTransport: vi.fn((agentId: string) =>
		agentId === "cline" ? "in_process_cline_sdk" : "pty_terminal",
	),
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
	]),
}));

vi.mock("@runtime-shortcuts", () => ({
	areRuntimeProjectShortcutsEqual: vi.fn(() => true),
}));

vi.mock("@/components/shared/cline-setup-section", () => ({
	ClineSetupSection: ({ onSaved }: { onSaved?: () => void }) => {
		clineSetupSectionOnSavedRef.onSaved = onSaved ?? null;
		return null;
	},
}));

vi.mock("@/hooks/use-runtime-settings-cline-controller", () => ({
	useRuntimeSettingsClineController: () => ({
		currentProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-3-7-sonnet",
			baseUrl: null,
			reasoningEffort: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		hasUnsavedChanges: false,
		providerId: "anthropic",
		saveProviderSettings: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/hooks/use-runtime-settings-cline-mcp-controller", () => ({
	useRuntimeSettingsClineMcpController: () => ({
		hasUnsavedChanges: false,
		saveMcpSettings: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutCustomizations: () => ({
		layoutResetNonce: 0,
		resetLayoutCustomizations: resetLayoutCustomizationsMock,
	}),
}));

vi.mock("@/runtime/use-runtime-config", () => ({
	useRuntimeConfig: (_open: boolean, _workspaceId: string | null, initialConfig?: RuntimeConfigResponse | null) => ({
		config: initialConfig ?? null,
		isLoading: false,
		isSaving: false,
		refresh: vi.fn(),
		save: useRuntimeConfigSaveMock,
	}),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(async () => undefined),
}));

vi.mock("@/utils/notification-permission", () => ({
	getBrowserNotificationPermission: () => "unsupported",
	requestBrowserNotificationPermission: vi.fn(async () => "unsupported"),
}));

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function findButtonByAriaLabel(container: ParentNode, ariaLabel: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find(
		(button) => button.getAttribute("aria-label") === ariaLabel,
	) ?? null) as HTMLButtonElement | null;
}

const savedClineOauthConfig = {
	selectedAgentId: "cline",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	newTaskStartInPlanModeByDefault: true,
	userInterfacePreferencesSharedAcrossBrowserOrigins:
		USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
	readyForReviewNotificationsEnabled: false,
	notificationSoundEnabled: false,
	autoContinueOnConnectionDropEnabled: false,
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: false,
	effectiveCommand: "cline",
	detectedCommands: [],
	shortcuts: [],
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	globalConfigPath: null,
	projectConfigPath: null,
	agents: [
		{
			id: "cline",
			label: "Cline",
			binary: "cline",
			command: "cline",
			installed: true,
		},
		{
			id: "claude",
			label: "Claude Code",
			binary: "claude",
			command: "claude",
			installed: true,
		},
	],
	clineProviderSettings: {
		providerId: null,
		modelId: "cline-sonnet",
		baseUrl: null,
		reasoningEffort: null,
		apiKeyConfigured: false,
		oauthProvider: "cline",
		oauthAccessTokenConfigured: true,
		oauthRefreshTokenConfigured: true,
		oauthAccountId: "acc-1",
		oauthExpiresAt: 1_800_000_000_000,
	},
} as unknown as RuntimeConfigResponse;

describe("RuntimeSettingsDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		for (const mock of Object.values(notificationSettingsMocks)) mock.mockReset();
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: savedNotificationSettings,
			providers: savedNotificationProviders,
		});
		notificationSettingsMocks.saveProvider.mockResolvedValue({ ok: true });
		notificationSettingsMocks.saveSettings.mockResolvedValue({ ok: true });
		resetLayoutCustomizationsMock.mockReset();
		useRuntimeConfigSaveMock.mockClear();
		useRuntimeConfigSaveMock.mockResolvedValue(true);
		clineSetupSectionOnSavedRef.onSaved = null;
		window.localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		window.localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderSettings(open = true, onOpenChange = vi.fn()) {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open={open}
					workspaceId="workspace-1"
					initialConfig={savedClineOauthConfig}
					onOpenChange={onOpenChange}
				/>,
			),
		);
	}
	async function changeInput(labelText: string, value: string, category?: "语言模型" | "TTS") {
		const scope = category
			? document.querySelector(`select[aria-label="编辑${category} provider"]`)?.closest("fieldset")
			: document;
		const label = Array.from(scope?.querySelectorAll("label") ?? []).find((label) =>
			label.textContent?.trim().startsWith(labelText),
		);
		const input = label?.querySelector("input");
		if (!input) throw new Error(`找不到输入框 ${labelText}`);
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function selectValue(label: string, value: string) {
		const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
		if (!select) throw new Error(`找不到选项 ${label}`);
		await act(async () => {
			select.value = value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
	}
	it("语言模型与 TTS 各自选择和添加 Provider，草稿与用途不串组", async () => {
		await renderSettings();
		const languageSelect = document.querySelector<HTMLSelectElement>('select[aria-label="编辑语言模型 provider"]');
		const speechSelect = document.querySelector<HTMLSelectElement>('select[aria-label="编辑TTS provider"]');
		expect(Array.from(languageSelect?.options ?? []).map((option) => option.textContent)).toEqual([
			"文本服务 · saved-text",
		]);
		expect(Array.from(speechSelect?.options ?? []).map((option) => option.textContent)).toEqual([
			"我的语音服务 · saved-tts",
		]);
		const languageGroup = languageSelect?.closest("fieldset")?.parentElement;
		const speechGroup = speechSelect?.closest("fieldset")?.parentElement;
		expect(languageGroup?.querySelector("legend")?.textContent).toBe("语言模型");
		expect(languageGroup?.textContent).toContain("通知判断与摘要 provider");
		expect(languageGroup?.textContent).not.toContain("TTS 模型");
		expect(speechGroup?.querySelector("legend")?.textContent).toBe("语音合成 TTS");
		expect(speechGroup?.textContent).toContain("TTS 模型");
		expect(speechGroup?.textContent).not.toContain("任务起名 provider");
		await act(async () => findButtonByText(document.body, "添加语言模型 Provider")?.click());
		await changeInput("显示名称", "独立的语言服务", "语言模型");
		await changeInput("Base URL", "https://example.com/v1", "语言模型");
		await changeInput("API Key", "test-language-only", "语言模型");
		expect(speechSelect?.value).toBe("1");
		await act(async () => findButtonByText(document.body, "添加TTS Provider")?.click());
		await changeInput("显示名称", "独立的语音服务", "TTS");
		await changeInput("API Key", "test-speech-only", "TTS");
		expect(languageSelect?.value).toBe("2");
		const languageCredentials = languageSelect?.closest("fieldset");
		expect(languageCredentials?.querySelector('input[type="password"]')).toHaveProperty(
			"value",
			"test-language-only",
		);
		const speechProtocol = Array.from(speechSelect?.closest("fieldset")?.querySelectorAll("select") ?? []).find(
			(select) => select.value === "deepinfra",
		);
		expect(Array.from(speechProtocol?.options ?? []).map((option) => option.value)).toEqual(["deepinfra", "alibaba"]);
		const allIds = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
		expect(new Set(allIds).size).toBe(allIds.length);
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({ providerProtocol: "openai_compatible", displayName: "独立的语言服务" }),
				apiKey: "test-language-only",
			}),
		);
		expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({ providerProtocol: "deepinfra", displayName: "独立的语音服务" }),
				apiKey: "test-speech-only",
			}),
		);
	});
	it("没有 Provider 时两组分别显示空状态，浏览器语音无需创建凭据", async () => {
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: { ...savedNotificationSettings, speechProvider: "browser", notificationSpeechBinding: null },
			providers: [],
		});
		await renderSettings();
		expect(document.body.textContent).toContain("尚未配置语言模型 Provider");
		expect(document.body.textContent).toContain("尚未配置TTS Provider");
		expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
		await changeInput("延期兜底", "15");
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).not.toHaveBeenCalled();
	});

	it.each(["保存", "试听"] as const)("%s 期间禁用共享语言选择，完成后恢复", async (operation) => {
		await renderSettings();
		const languageSelect = document.querySelector<HTMLSelectElement>("#notification-intelligence-selection-5");
		if (!languageSelect) throw new Error("缺少共享语言选择");
		expect(languageSelect.disabled).toBe(false);
		let finishOperation = () => {};
		const pendingOperation = new Promise<void>((resolve) => {
			finishOperation = resolve;
		});
		if (operation === "保存") {
			await changeInput("延期兜底", "15");
			notificationSettingsMocks.saveSettings.mockImplementationOnce(async () => {
				await pendingOperation;
				return { ok: true };
			});
		} else {
			notificationSettingsMocks.previewSpeech.mockReturnValueOnce(pendingOperation);
		}
		await act(async () =>
			findButtonByText(document.body, operation === "保存" ? "Save" : "试听已保存设置（产生 API 费用）")?.click(),
		);
		try {
			expect(languageSelect.disabled).toBe(true);
			expect(languageSelect.value).toBe("zh-CN");
		} finally {
			await act(async () => finishOperation());
		}
		expect(languageSelect.disabled).toBe(false);
	});

	it("统一保存多个 Provider 草稿和通知设置，显示已保存凭据，试听不隐式保存", async () => {
		const onOpenChange = vi.fn();
		await renderSettings(true, onOpenChange);
		expect(document.querySelector<HTMLSelectElement>('select[aria-label="编辑TTS provider"]')?.value).toBe("1");
		expect(document.body.textContent).toContain(
			"已保存：我的语音服务（saved-tts） · 系统钥匙串 · 凭据已配置（不回显）",
		);
		expect(findButtonByText(document.body, "保存 provider")).toBeNull();
		expect(findButtonByText(document.body, "保存 AI 与语音设置")).toBeNull();
		await act(async () => findButtonByText(document.body, "试听已保存设置（产生 API 费用）")?.click());
		expect(notificationSettingsMocks.previewSpeech).toHaveBeenCalledTimes(1);
		expect(notificationSettingsMocks.saveSettings).not.toHaveBeenCalled();
		await changeInput("API Key", "test-only-replacement");
		await selectValue("编辑语言模型 provider", "0");
		await changeInput("显示名称", "新的文本服务名称");
		await selectValue("编辑TTS provider", "1");
		expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("test-only-replacement");
		const language = document.querySelector<HTMLSelectElement>("#notification-intelligence-selection-5");
		if (!language) throw new Error("缺少语言选择");
		await act(async () => {
			language.value = "en-US";
			language.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(notificationSettingsMocks.saveProvider).not.toHaveBeenCalled();
		expect(findButtonByText(document.body, "Save")?.disabled).toBe(false);
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledTimes(2);
		expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "test-only-replacement" }),
		);
		expect(notificationSettingsMocks.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ summaryLanguage: "en-US" }),
		);
		expect(useRuntimeConfigSaveMock).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
	it.each(["未编辑", "修改名称", "输入密钥", "用途绑定"] as const)(
		"添加 Provider 后统一保存：%s 草稿只在编辑或绑定后持久化",
		async (draftAction) => {
			const onOpenChange = vi.fn();
			await renderSettings(true, onOpenChange);
			await act(async () => findButtonByText(document.body, "添加TTS Provider")?.click());
			expect(document.querySelector<HTMLSelectElement>('select[aria-label="编辑TTS provider"]')?.value).toBe("2");
			if (draftAction === "修改名称") await changeInput("显示名称", "新的语音服务", "TTS");
			if (draftAction === "输入密钥") await changeInput("API Key", "test-only-new-provider");
			if (draftAction === "用途绑定") {
				const binding = document.querySelector<HTMLSelectElement>("#notification-intelligence-selection-9");
				if (!binding) throw new Error("缺少 TTS Provider 绑定");
				await act(async () => {
					binding.value = "provider-3";
					binding.dispatchEvent(new Event("change", { bubbles: true }));
				});
			}
			await changeInput("延期兜底", "15");
			await act(async () => findButtonByText(document.body, "Save")?.click());
			expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledTimes(draftAction === "未编辑" ? 0 : 1);
			if (draftAction !== "未编辑")
				expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledWith(
					expect.objectContaining({
						profile: expect.objectContaining({ modelProviderId: "provider-3" }),
					}),
				);
			expect(notificationSettingsMocks.saveSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					fallbackAfterMinutes: 15,
					notificationSpeechBinding: {
						modelProviderId: draftAction === "用途绑定" ? "provider-3" : "saved-tts",
						modelId: "hexgrad/Kokoro-82M",
					},
				}),
			);
			expect(onOpenChange).toHaveBeenCalledWith(false);
		},
	);
	it("取消丢弃密钥删除和表单草稿；重新打开回到 General", async () => {
		const onOpenChange = vi.fn();
		await renderSettings(true, onOpenChange);
		const body = document.querySelector('[data-settings-section="general"]')?.parentElement;
		if (!body) throw new Error("缺少滚动容器");
		body.scrollTo = vi.fn();
		await act(async () => findButtonByText(document.body, "Notifications")?.click());
		expect(findButtonByText(document.body, "Notifications")?.getAttribute("aria-current")).toBe("location");
		await act(async () => findButtonByText(document.body, "删除已保存密钥（待保存）")?.click());
		await changeInput("显示名称", "待丢弃的名称", "TTS");
		await act(async () => findButtonByText(document.body, "Cancel")?.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(notificationSettingsMocks.saveProvider).not.toHaveBeenCalled();
		await renderSettings(false);
		await renderSettings();
		expect(findButtonByText(document.body, "General")?.getAttribute("aria-current")).toBe("location");
		expect(findButtonByText(document.body, "Notifications")?.getAttribute("aria-current")).toBeNull();
		expect(document.body.textContent).not.toContain("待丢弃的名称");
		expect(findButtonByText(document.body, "撤销删除密钥")).toBeNull();
		expect(findButtonByText(document.body, "Save")?.disabled).toBe(true);
	});
	it("已落盘的坏文本绑定显示为已失效而非伪装成默认配置，且不阻止保存其它字段", async () => {
		const onOpenChange = vi.fn();
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: {
				...savedNotificationSettings,
				taskNameSuggestionBinding: { modelProviderId: "saved-tts", modelId: "text-model" },
			},
			providers: savedNotificationProviders,
		});
		await renderSettings(true, onOpenChange);
		const taskNameBinding = document.querySelector<HTMLSelectElement>(
			"#notification-intelligence-selection-4-taskNameSuggestionBinding",
		);
		expect(taskNameBinding?.value).toBe("saved-tts");
		expect(taskNameBinding?.selectedOptions[0]?.textContent).toContain("已失效");
		expect(document.body.textContent).toContain(
			"「任务起名」绑定的 provider saved-tts 服务类型为DeepInfra TTS，需为 OpenAI 兼容文本模型",
		);
		await changeInput("延期兜底", "25");
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ fallbackAfterMinutes: 25 }),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
	it("添加 Provider 的自动 id 避开悬空绑定引用的 id，历史 not_found 绑定不会被误判为新引入而锁死保存", async () => {
		const onOpenChange = vi.fn();
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: {
				...savedNotificationSettings,
				taskNameSuggestionBinding: { modelProviderId: "provider-3", modelId: "text-model" },
			},
			providers: savedNotificationProviders,
		});
		await renderSettings(true, onOpenChange);
		await act(async () => findButtonByText(document.body, "添加TTS Provider")?.click());
		const providerEditor = document.querySelector('select[aria-label="编辑TTS provider"]')?.closest("fieldset");
		const providerIdInput = Array.from(providerEditor?.querySelectorAll("label") ?? [])
			.find((label) => label.textContent?.trim().startsWith("Provider ID"))
			?.querySelector("input");
		expect(providerIdInput?.value).toBe("provider-4");
		await changeInput("延期兜底", "35");
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).not.toHaveBeenCalled();
		expect(notificationSettingsMocks.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ fallbackAfterMinutes: 35 }),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
	it("清空被文本用途引用的 Provider Base URL 时，Save 在写入前拒绝，一个请求都不发", async () => {
		const onOpenChange = vi.fn();
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: {
				...savedNotificationSettings,
				taskNameSuggestionBinding: { modelProviderId: "saved-text", modelId: "text-model" },
			},
			providers: [
				{ ...savedNotificationProviders[0], baseUrl: "https://example.invalid" },
				savedNotificationProviders[1],
			],
		});
		await renderSettings(true, onOpenChange);
		await selectValue("编辑语言模型 provider", "0");
		await changeInput("Base URL", "", "语言模型");
		expect(document.body.textContent).toContain("「任务起名」绑定的 provider saved-text 缺少 Base URL");
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).not.toHaveBeenCalled();
		expect(notificationSettingsMocks.saveSettings).not.toHaveBeenCalled();
		expect(useRuntimeConfigSaveMock).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("保存未完成");
	});
	it("保存失败保留密钥草稿和对话框，重试后才关闭", async () => {
		const onOpenChange = vi.fn();
		await renderSettings(true, onOpenChange);
		await changeInput("API Key", "test-only-retry");
		notificationSettingsMocks.saveProvider.mockRejectedValueOnce(new Error("系统钥匙串不可用"));
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(useRuntimeConfigSaveMock).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("保存未完成，草稿已保留");
		expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("test-only-retry");
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("浏览器音色在 Cancel 时保留原值，且仅在统一 Save 后写入", async () => {
		localStorage.setItem("kanban-notification-browser-voice-uri", "voice-original");
		notificationSettingsMocks.getSettings.mockResolvedValue({
			settings: { ...savedNotificationSettings, speechProvider: "browser", notificationSpeechBinding: null },
			providers: savedNotificationProviders,
		});
		await renderSettings();
		const voiceSelect = document.querySelector<HTMLSelectElement>("#notification-intelligence-selection-8");
		if (!voiceSelect) throw new Error("缺少浏览器音色选项");
		await act(async () => {
			voiceSelect.value = "";
			voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(localStorage.getItem("kanban-notification-browser-voice-uri")).toBe("voice-original");
		await renderSettings(false);
		await renderSettings();
		expect(findButtonByText(document.body, "Save")?.disabled).toBe(true);
		const reopenedSelect = document.querySelector<HTMLSelectElement>("#notification-intelligence-selection-8");
		if (!reopenedSelect) throw new Error("缺少浏览器音色选项");
		await act(async () => {
			reopenedSelect.value = "";
			reopenedSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(localStorage.getItem("kanban-notification-browser-voice-uri")).toBe("");
	});
	it("通知部分已保存但整体保存失败时，仍允许点击 Save 重试", async () => {
		const onOpenChange = vi.fn();
		await renderSettings(true, onOpenChange);
		await changeInput("API Key", "test-only-partial-save");
		useRuntimeConfigSaveMock.mockResolvedValueOnce(false);
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText(document.body, "Save")?.disabled).toBe(false);
		await act(async () => findButtonByText(document.body, "Save")?.click());
		expect(notificationSettingsMocks.saveProvider).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("does not render support actions inside settings", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		expect(findButtonByText(document.body, "Send feedback")).toBeNull();
		expect(findButtonByText(document.body, "Report issue")).toBeNull();
	});

	it("calls the layout reset callback when reset layout is clicked", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		const resetButton = findButtonByText(document.body, "Reset layout");
		expect(resetButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			resetButton?.click();
		});

		expect(resetLayoutCustomizationsMock).toHaveBeenCalledTimes(1);
	});

	// 行内开关定位：先按文案找到该行的 <span> label，再取同一行里的 Radix Switch（role="switch"）。
	function findSwitchByRowLabel(rootEl: ParentNode, labelText: string): HTMLButtonElement | null {
		const label = Array.from(rootEl.querySelectorAll("span")).find((el) => el.textContent?.trim() === labelText);
		const row = label?.closest("div");
		return (row?.querySelector('button[role="switch"]') as HTMLButtonElement | null) ?? null;
	}

	it("saves the new-task plan mode default switch", async () => {
		const handleOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={handleOpenChange}
				/>,
			);
		});

		const defaultPlanModeSwitch = findSwitchByRowLabel(document.body, "Start new tasks in plan mode by default");
		const saveButton = findButtonByText(document.body, "Save");
		expect(defaultPlanModeSwitch).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			defaultPlanModeSwitch?.click();
		});
		await act(async () => {
			saveButton?.click();
		});

		expect(useRuntimeConfigSaveMock).toHaveBeenCalledWith(
			// 设置对话框不碰跨 origin 共享的那组界面偏好（它们由各自的控件经外部 store 写），
			// 所以这里刻意只断言它改动的那个字段。
			expect.objectContaining({
				newTaskStartInPlanModeByDefault: false,
			}),
		);
		expect(handleOpenChange).toHaveBeenCalledWith(false);
	});

	it("disables the notification sound switch when ready-for-review notifications are off", async () => {
		// savedClineOauthConfig 关着 readyForReviewNotificationsEnabled → 「Play a sound」应随父开关置灰。
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		const reviewSwitch = findSwitchByRowLabel(document.body, "Notify when a task is ready for review");
		const soundSwitch = findSwitchByRowLabel(document.body, "Play a sound");
		expect(reviewSwitch).toBeInstanceOf(HTMLButtonElement);
		expect(soundSwitch).toBeInstanceOf(HTMLButtonElement);
		expect(soundSwitch?.disabled).toBe(true);
	});

	it("enables the notification sound switch when ready-for-review notifications are on", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={
						{
							...savedClineOauthConfig,
							readyForReviewNotificationsEnabled: true,
							notificationSoundEnabled: true,
						} as unknown as RuntimeConfigResponse
					}
					onOpenChange={() => {}}
				/>,
			);
		});

		const soundSwitch = findSwitchByRowLabel(document.body, "Play a sound");
		expect(soundSwitch).toBeInstanceOf(HTMLButtonElement);
		expect(soundSwitch?.disabled).toBe(false);
	});

	it("enables save on theme change and reverts preview on cancel", async () => {
		const handleOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={handleOpenChange}
				/>,
			);
		});

		const saveButton = findButtonByText(document.body, "Save");
		const cancelButton = findButtonByText(document.body, "Cancel");
		const themeSelectTrigger = findButtonByAriaLabel(document.body, "Theme");

		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
		expect(themeSelectTrigger).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);
		expect(themeSelectTrigger?.className).toContain("cursor-pointer");
		expect(themeSelectTrigger?.parentElement?.parentElement?.className).toContain("w-1/2");

		// The mock Radix Select renders items as buttons with role="option".
		// Click the Graphite option to trigger onValueChange.
		const graphiteOption = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
			el.textContent?.includes("Graphite"),
		) as HTMLElement | undefined;
		expect(graphiteOption).toBeTruthy();
		await act(async () => {
			graphiteOption?.click();
		});

		expect(document.documentElement.getAttribute("data-theme")).toBe("graphite");
		expect(saveButton?.disabled).toBe(false);
		expect(window.localStorage.getItem("kanban.theme")).toBeNull();

		await act(async () => {
			cancelButton?.click();
		});

		expect(handleOpenChange).toHaveBeenCalledWith(false);
		expect(window.localStorage.getItem("kanban.theme")).toBeNull();
		expect(document.documentElement.getAttribute("data-theme")).toBeNull();
	});

	it("persists theme selection only after clicking save", async () => {
		const handleOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={handleOpenChange}
				/>,
			);
		});

		const saveButton = findButtonByText(document.body, "Save");

		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		// Click the Graphite option to trigger onValueChange.
		const graphiteOption = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
			el.textContent?.includes("Graphite"),
		) as HTMLElement | undefined;
		expect(graphiteOption).toBeTruthy();
		await act(async () => {
			graphiteOption?.click();
		});

		expect(window.localStorage.getItem("kanban.theme")).toBeNull();

		await act(async () => {
			saveButton?.click();
		});

		expect(handleOpenChange).toHaveBeenCalledWith(false);
		expect(window.localStorage.getItem("kanban.theme")).toBe("graphite");
		expect(document.documentElement.getAttribute("data-theme")).toBe("graphite");
	});

	it("forwards cline setup saves to the dialog onSaved callback", async () => {
		const handleSaved = vi.fn();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					workspaceId={"workspace-1"}
					initialConfig={savedClineOauthConfig}
					onOpenChange={() => {}}
					onSaved={handleSaved}
				/>,
			);
		});

		expect(clineSetupSectionOnSavedRef.onSaved).toBeTypeOf("function");

		await act(async () => {
			clineSetupSectionOnSavedRef.onSaved?.();
		});

		expect(handleSaved).toHaveBeenCalledTimes(1);
	});
});
