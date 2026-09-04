import { describe, expect, it } from "vitest";

import {
	DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
	getModelProviderApiKeyEnvironmentVariableName,
	KNOWN_MODEL_PROVIDER_DEFAULTS,
	readConfiguredModelProviderIds,
	resolveDefaultModelProviderId,
	resolveModelProviderCredential,
} from "../../../src/model-provider-access/model-provider-credentials-from-environment.js";

const DEEPSEEK_API_KEY_VARIABLE = getModelProviderApiKeyEnvironmentVariableName("deepseek");

describe("getModelProviderApiKeyEnvironmentVariableName", () => {
	it("uppercases the provider id and turns hyphens into underscores", () => {
		expect(DEEPSEEK_API_KEY_VARIABLE).toBe("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY");
		expect(getModelProviderApiKeyEnvironmentVariableName("my-gateway")).toBe(
			"KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY",
		);
	});
});

describe("readConfiguredModelProviderIds", () => {
	it("finds every provider that has an API key, sorted, ignoring unrelated variables", () => {
		expect(
			readConfiguredModelProviderIds({
				KANBAN_MODEL_PROVIDER_OPENROUTER_API_KEY: "sk-b",
				KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "sk-a",
				// base_url / model_id 单独出现不构成「配了这家」——没 key 就发不出请求。
				KANBAN_MODEL_PROVIDER_GHOST_BASE_URL: "https://ghost.example",
				KANBAN_RUNTIME_PORT: "3484",
			}),
		).toEqual(["deepseek", "openrouter"]);
	});

	it("maps an underscore segment back to a hyphenated provider id", () => {
		expect(readConfiguredModelProviderIds({ KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY: "sk" })).toEqual([
			"my-gateway",
		]);
	});

	it("treats a whitespace-only key as not configured", () => {
		expect(readConfiguredModelProviderIds({ [DEEPSEEK_API_KEY_VARIABLE]: "   " })).toEqual([]);
	});
});

describe("resolveModelProviderCredential", () => {
	it("fills base URL and model from the built-in defaults of a known provider", () => {
		expect(resolveModelProviderCredential("deepseek", { [DEEPSEEK_API_KEY_VARIABLE]: "sk-test" })).toEqual({
			modelProviderId: "deepseek",
			apiKey: "sk-test",
			baseUrl: KNOWN_MODEL_PROVIDER_DEFAULTS.deepseek?.baseUrl,
			modelId: KNOWN_MODEL_PROVIDER_DEFAULTS.deepseek?.modelId,
		});
	});

	it("lets base URL and model be overridden per provider and strips a trailing slash", () => {
		expect(
			resolveModelProviderCredential("deepseek", {
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-test",
				KANBAN_MODEL_PROVIDER_DEEPSEEK_BASE_URL: "https://gateway.example/v1/",
				KANBAN_MODEL_PROVIDER_DEEPSEEK_MODEL_ID: "some-other-model",
			}),
		).toEqual({
			modelProviderId: "deepseek",
			apiKey: "sk-test",
			// 结尾斜杠必须被吃掉，否则调用方拼出来的是 `.../v1//chat/completions`。
			baseUrl: "https://gateway.example/v1",
			modelId: "some-other-model",
		});
	});

	it("supports a provider nobody has heard of, as long as all three are configured", () => {
		expect(
			resolveModelProviderCredential("my-gateway", {
				KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY: "sk-gateway",
				KANBAN_MODEL_PROVIDER_MY_GATEWAY_BASE_URL: "https://my-gateway.example",
				KANBAN_MODEL_PROVIDER_MY_GATEWAY_MODEL_ID: "house-model",
			}),
		).toEqual({
			modelProviderId: "my-gateway",
			apiKey: "sk-gateway",
			baseUrl: "https://my-gateway.example",
			modelId: "house-model",
		});
	});

	it("refuses to guess an endpoint for an unknown provider that only has a key", () => {
		expect(
			resolveModelProviderCredential("my-gateway", { KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY: "sk" }),
		).toBeNull();
	});

	it("returns null when the provider has no API key at all", () => {
		expect(resolveModelProviderCredential("deepseek", {})).toBeNull();
	});
});

describe("resolveDefaultModelProviderId", () => {
	it("uses the only configured provider without needing an explicit default", () => {
		expect(resolveDefaultModelProviderId({ [DEEPSEEK_API_KEY_VARIABLE]: "sk" })).toBe("deepseek");
	});

	it("honours an explicit default when several providers are configured", () => {
		expect(
			resolveDefaultModelProviderId({
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-a",
				KANBAN_MODEL_PROVIDER_OPENROUTER_API_KEY: "sk-b",
				[DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "openrouter",
			}),
		).toBe("openrouter");
	});

	it("refuses to pick one when several are configured and none is declared default", () => {
		expect(
			resolveDefaultModelProviderId({
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-a",
				KANBAN_MODEL_PROVIDER_OPENROUTER_API_KEY: "sk-b",
			}),
		).toBeNull();
	});

	it("ignores an explicit default that points at an unconfigured provider", () => {
		expect(
			resolveDefaultModelProviderId({
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-a",
				KANBAN_MODEL_PROVIDER_OPENROUTER_API_KEY: "sk-b",
				[DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "never-configured",
			}),
		).toBeNull();
	});

	// 上面那条为 null 其实是被「配了多家就不挑」先兜住的，覆盖不到真正的分歧路径：**只配了一家** +
	// 显式默认指向没配的那家。那条路径以前会静默落回单 provider 兜底，把请求发到用户没指定的那家。
	it("refuses the single-provider fallback when an explicit default points at an unconfigured provider", () => {
		expect(
			resolveDefaultModelProviderId({
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-a",
				[DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "openrouter",
			}),
		).toBeNull();
	});

	// 「有约束力」只针对真的写了值的显式默认；空白值等于没写，单 provider 兜底照常生效。
	it("still falls back to the only configured provider when the explicit default is blank", () => {
		expect(
			resolveDefaultModelProviderId({
				[DEEPSEEK_API_KEY_VARIABLE]: "sk-a",
				[DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "   ",
			}),
		).toBe("deepseek");
	});

	it("returns null when nothing is configured", () => {
		expect(resolveDefaultModelProviderId({})).toBeNull();
	});
});
