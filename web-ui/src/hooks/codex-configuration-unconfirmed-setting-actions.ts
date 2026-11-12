import {
	codexConfigurationBatchActionRequestSchema,
	codexConfigurationProfileMutationRequestSchema,
} from "@runtime-contract";
import { z } from "zod";
import type { CodexConfigurationBatchActionRequest, CodexConfigurationProfileMutationRequest } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

type SettingMutation =
	| { kind: "profile"; input: CodexConfigurationProfileMutationRequest }
	| { kind: "feedback"; input: CodexConfigurationBatchActionRequest };
const persistedCodexConfigurationSettingActionMetadataSchema = z.object({
	workspaceId: z.string().nullable(),
	storageIdentity: z.string().nullable(),
	identity: z.string(),
	automaticResendCount: z.number().int().nonnegative().catch(0),
});
const unconfirmedCodexConfigurationSettingActionSchema = z.discriminatedUnion("kind", [
	persistedCodexConfigurationSettingActionMetadataSchema.extend({
		kind: z.literal("profile"),
		input: codexConfigurationProfileMutationRequestSchema,
	}),
	persistedCodexConfigurationSettingActionMetadataSchema.extend({
		kind: z.literal("feedback"),
		input: codexConfigurationBatchActionRequestSchema,
	}),
]);
export type UnconfirmedCodexConfigurationSettingAction = z.infer<
	typeof unconfirmedCodexConfigurationSettingActionSchema
>;
const storageKey = LocalStorageKey.CodexConfigurationUnconfirmedSettingActions;
const recoveryListeners = new Set<() => void>();
export function subscribeUnconfirmedCodexConfigurationSettingActions(listener: () => void) {
	recoveryListeners.add(listener);
	return () => recoveryListeners.delete(listener);
}
export function notifyUnconfirmedCodexConfigurationSettingActionsChanged() {
	for (const listener of recoveryListeners) listener();
}
export function readUnconfirmedCodexConfigurationSettingActions(): UnconfirmedCodexConfigurationSettingAction[] {
	try {
		const values: unknown = JSON.parse(readLocalStorageItem(storageKey) ?? "[]");
		if (!Array.isArray(values)) return [];
		return values.flatMap((value) => {
			const parsed = unconfirmedCodexConfigurationSettingActionSchema.safeParse(value);
			return parsed.success ? [parsed.data] : [];
		});
	} catch {
		return [];
	}
}
export function rememberUnconfirmedCodexConfigurationSettingAction(
	workspaceId: string | null,
	storageIdentity: string | null,
	mutation: SettingMutation,
) {
	const input =
		mutation.kind === "profile"
			? { ...mutation.input, idempotencyKey: undefined, stateResponseScope: undefined }
			: {
					...mutation.input,
					stateResponseScope: undefined,
					items: mutation.input.items.map((item) => ({ ...item, idempotencyKey: undefined })),
				};
	const identity = JSON.stringify([workspaceId, storageIdentity, mutation.kind, input]);
	const pending = readUnconfirmedCodexConfigurationSettingActions();
	const existing = pending.find((entry) => entry.identity === identity);
	const action = existing ?? { ...mutation, workspaceId, storageIdentity, identity, automaticResendCount: 0 };
	if (!existing && !writeLocalStorageItem(storageKey, JSON.stringify([...pending, action])))
		throw new Error("原操作身份未能持久保存，已停止发送。");
	return { action, requiresReceiptCheck: !!existing };
}
export function forgetUnconfirmedCodexConfigurationSettingAction(identity: string) {
	writeLocalStorageItem(
		storageKey,
		JSON.stringify(readUnconfirmedCodexConfigurationSettingActions().filter((entry) => entry.identity !== identity)),
	);
}

export function recordUnconfirmedCodexConfigurationSettingActionAutomaticResend(identity: string) {
	const actions = readUnconfirmedCodexConfigurationSettingActions();
	const action = actions.find((entry) => entry.identity === identity);
	if (!action || action.automaticResendCount >= 1)
		throw new Error("原操作已用完自动重送预算，保留身份并继续核验回执。");
	action.automaticResendCount++;
	if (!writeLocalStorageItem(storageKey, JSON.stringify(actions)))
		throw new Error("自动重送预算未能持久保存，已停止重送。");
}

export function isConfirmedCodexConfigurationProfileMutationRejection(error: unknown) {
	if (!(error instanceof Error)) return false;
	return (
		[
			"相关默认字段已更新",
			"Codex profile 已更新",
			"会话代际或配置来源已变化",
			"此字段不属于",
			"模型与推理强度必须",
			"hook 信任与撤销必须",
		].some((prefix) => error.message.startsWith(prefix)) ||
		(error.message.startsWith("模型 ") && error.message.includes("不支持推理强度"))
	);
}
