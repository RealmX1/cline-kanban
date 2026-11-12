import {
	codexConfigurationProfileFieldVersionRequirements,
	expandCodexConfigurationProfileFieldEdit,
	isCodexLocalStateConfigurationField,
} from "@runtime-codex-configuration-profile-field-editing";
import { useEffect, useId, useState } from "react";
import { CodexTaskReasoningEffortSelect } from "@/components/codex-task-reasoning-effort-select";
import { useTaskAgentModelPicker } from "@/components/task-agent-model-picker";
import { Button } from "@/components/ui/button";
import { resolveCodexTaskReasoningEffortSelection } from "@/hooks/codex-task-reasoning-effort-selection";
import type { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationProfile } from "@/runtime/types";

type Controller = Pick<
	ReturnType<typeof useCodexConfigurationSync>,
	| "workspaceId"
	| "historicalDefaultEditRequest"
	| "clearHistoricalDefaultEditRequest"
	| "profileAction"
	| "pendingChangeId"
>;
type FieldEdit = { fieldKey: string; value: unknown; delete?: boolean };
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const effortFieldKey = JSON.stringify(["config.toml", "model_reasoning_effort"]);
const inputClassName =
	"min-h-9 w-full min-w-0 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
const versions = (profile: CodexConfigurationProfile) =>
	profile.fieldVersions ?? Object.fromEntries(profile.fields.map((field) => [field.fieldKey, field.version]));

export function CodexConfigurationProfileDefaultEditor({
	profile,
	controller,
}: {
	profile: CodexConfigurationProfile;
	controller: Controller;
}) {
	const [baseline, setBaseline] = useState(profile);
	const [edits, setEdits] = useState<Record<string, FieldEdit>>({});
	const [advancedSearch, setAdvancedSearch] = useState("");
	const [advancedDrafts, setAdvancedDrafts] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [isExpanded, setIsExpanded] = useState(false);
	const formId = useId();
	const dirty = Object.keys(edits).length > 0 || Object.keys(advancedDrafts).length > 0;
	const picker = useTaskAgentModelPicker({
		active: isExpanded,
		workspaceId: controller.workspaceId,
		agentId: "codex",
	});
	useEffect(() => {
		if (!dirty) setBaseline(profile);
	}, [dirty, profile]);
	const reshare = controller.historicalDefaultEditRequest;
	useEffect(() => {
		if (!reshare || reshare.profileId !== profile.profileId) return;
		setBaseline(profile);
		setEdits(
			Object.fromEntries(
				reshare.fields
					.filter(
						(edit) =>
							JSON.stringify(profile.fields.find((field) => field.fieldKey === edit.fieldKey)?.value) !==
							JSON.stringify(edit.delete ? undefined : edit.value),
					)
					.map((edit) => [edit.fieldKey, edit]),
			),
		);
		setAdvancedDrafts({});
		setIsExpanded(true);
		setError(null);
	}, [reshare]);
	const resolveDraftFieldValue = (key: string) =>
		key in edits
			? edits[key]?.delete
				? undefined
				: edits[key]?.value
			: baseline.fields.find((field) => field.fieldKey === key)?.value;
	const setField = (fieldKey: string, value: unknown, remove = false) => {
		const saved = baseline.fields.find((field) => field.fieldKey === fieldKey)?.value;
		setEdits((current) => {
			const next = { ...current };
			if (JSON.stringify(saved) === JSON.stringify(remove ? undefined : value)) delete next[fieldKey];
			else next[fieldKey] = { fieldKey, value, delete: remove };
			return next;
		});
		setError(null);
	};
	const draftModel = resolveDraftFieldValue(modelFieldKey);
	const draftEffort = resolveDraftFieldValue(effortFieldKey);
	const reasoning = resolveCodexTaskReasoningEffortSelection({
		profile: {
			...baseline,
			fields: baseline.fields.filter(
				(field) => field.fieldKey !== modelFieldKey && field.fieldKey !== effortFieldKey,
			),
		},
		explicitModelId: typeof draftModel === "string" ? draftModel : undefined,
		override: typeof draftEffort === "string" ? draftEffort : undefined,
		catalog: picker.terminalAgentModelCatalog,
		catalogWarning: picker.terminalAgentModelCatalogWarning,
		catalogIsLoading: picker.isLoadingTerminalAgentModels,
	});
	const submittedEdits = Object.values(edits).flatMap((edit) => expandCodexConfigurationProfileFieldEdit(edit));
	const expectedFieldVersions = codexConfigurationProfileFieldVersionRequirements(
		versions(baseline),
		submittedEdits.map((edit) => edit.fieldKey),
	);
	const currentRequirements = codexConfigurationProfileFieldVersionRequirements(versions(profile), Object.keys(edits));
	const hasConflict = Object.entries(currentRequirements).some(
		([key, version]) => expectedFieldVersions[key] !== version,
	);
	const permissions = baseline.fields.filter((field) => field.exceptionGroup === "permissions");
	const knownPermissions = [
		"approval_policy",
		"approvals_reviewer",
		"sandbox_mode",
		"sandbox_workspace_write",
		"permissions",
	].map((name) => ({
		fieldKey: JSON.stringify(["config.toml", name]),
		fieldLabel: name,
		value: undefined,
		valueSummary: "沿用原生默认",
		version: 0,
		exceptionGroup: "permissions" as const,
	}));
	const permissionFields = [
		...permissions,
		...knownPermissions.filter(
			(field) =>
				!permissions.some(
					(entry) =>
						entry.fieldKey === field.fieldKey || entry.fieldKey.startsWith(`${field.fieldKey.slice(0, -1)},`),
				),
		),
	];
	const advanced = baseline.fields.filter(
		(field) =>
			(field.exceptionGroup === null ||
				((field.exceptionGroup === "model" || field.exceptionGroup === "reasoning_effort") &&
					field.fieldKey !== modelFieldKey &&
					field.fieldKey !== effortFieldKey)) &&
			!isCodexLocalStateConfigurationField(field.fieldKey) &&
			`${field.fieldLabel} ${field.valueSummary}`.toLocaleLowerCase().includes(advancedSearch.toLocaleLowerCase()),
	);
	const renderJsonEditor = (field: CodexConfigurationProfile["fields"][number]) => {
		const value = resolveDraftFieldValue(field.fieldKey);
		const draft = advancedDrafts[field.fieldKey] ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
		const hookState = field.fieldKey.includes('"hooks","state"');
		return (
			<div key={field.fieldKey} className="space-y-1 border-b border-border py-3">
				<label
					className="block break-words text-sm font-medium text-text-primary"
					htmlFor={`${formId}-${field.fieldKey}`}
				>
					{field.fieldLabel}
				</label>
				{hookState ? (
					<select
						id={`${formId}-${field.fieldKey}`}
						className={inputClassName}
						value={String((value as { enabled?: boolean })?.enabled !== false)}
						onChange={(event) =>
							setField(field.fieldKey, {
								...(value as Record<string, unknown>),
								enabled: event.target.value === "true",
							})
						}
					>
						<option value="true">开启</option>
						<option value="false">关闭</option>
					</select>
				) : (
					<textarea
						id={`${formId}-${field.fieldKey}`}
						className={`${inputClassName} min-h-16 font-mono`}
						rows={2}
						value={draft}
						placeholder="沿用原生默认；输入 JSON 显式设置"
						onChange={(event) => {
							const text = event.target.value;
							setAdvancedDrafts((current) => ({ ...current, [field.fieldKey]: text }));
							try {
								setField(field.fieldKey, text.trim() ? JSON.parse(text) : undefined, !text.trim());
								setAdvancedDrafts((current) => {
									const next = { ...current };
									delete next[field.fieldKey];
									return next;
								});
							} catch {
								setError(`${field.fieldLabel} 需要有效 JSON。`);
							}
						}}
					/>
				)}
				<p className="m-0 text-xs text-text-secondary">
					已保存默认：
					{profile.fields.find((entry) => entry.fieldKey === field.fieldKey)?.valueSummary ?? "沿用原生默认"}
				</p>
			</div>
		);
	};
	const save = async () => {
		if (hasConflict || reasoning.validationError || Object.keys(advancedDrafts).length) return;
		if (
			await controller.profileAction({
				action: "update",
				profileId: profile.profileId,
				expectedVersion: baseline.version,
				expectedFieldVersions,
				fields: submittedEdits,
				idempotencyKey: crypto.randomUUID(),
			})
		) {
			setEdits({});
			setAdvancedDrafts({});
			setError(null);
			controller.clearHistoricalDefaultEditRequest();
		}
	};
	return (
		<details
			open={isExpanded}
			onToggle={(event) => setIsExpanded(event.currentTarget.open)}
			className="border-b border-border py-3"
			data-verification-anchor="codex-configuration-default-editor"
		>
			<summary className="cursor-pointer text-sm font-semibold text-text-primary focus-visible:outline-2 focus-visible:outline-accent">
				编辑默认{dirty ? " · 有未保存草稿" : ""}
			</summary>
			<div className="space-y-4 pt-4">
				{reshare?.profileId === profile.profileId && (
					<p role="status" className="text-sm text-status-orange">
						已预填历史值。确认后会创建新共享操作，原历史记录保留。
					</p>
				)}
				<div>
					<label htmlFor={`${formId}-model`} className="mb-1 block text-sm font-medium text-text-primary">
						模型
					</label>
					<select
						id={`${formId}-model`}
						className={inputClassName}
						value={typeof draftModel === "string" ? draftModel : ""}
						onChange={(event) => setField(modelFieldKey, event.target.value || undefined, !event.target.value)}
					>
						<option value="">沿用原生默认</option>
						{typeof draftModel === "string" &&
							!picker.terminalAgentModelCatalog?.options.some((option) => option.modelId === draftModel) && (
								<option value={draftModel}>{draftModel}（保留选择）</option>
							)}
						{picker.terminalAgentModelCatalog?.options.map((option) => (
							<option key={option.modelId} value={option.modelId}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<CodexTaskReasoningEffortSelect
					value={typeof draftEffort === "string" ? draftEffort : undefined}
					selection={reasoning}
					onChange={(value) => setField(effortFieldKey, value, value === undefined)}
					onRetry={picker.retryTerminalAgentModelCatalog}
					scope="profile_default"
				/>
				<details>
					<summary className="cursor-pointer text-sm font-semibold text-text-primary">
						完整权限 · 联合校验整组版本
					</summary>
					<p className="text-xs text-text-secondary">
						保存只提交修改字段；其他权限、嵌套策略以及新增或删除成员都参加冲突校验。
					</p>
					{permissionFields.map(renderJsonEditor)}
				</details>
				<details>
					<summary className="cursor-pointer text-sm text-text-secondary">高级设置 · {advanced.length} 项</summary>
					<input
						type="search"
						aria-label="搜索高级配置字段"
						placeholder="搜索配置字段"
						className={`${inputClassName} mt-3`}
						value={advancedSearch}
						onChange={(event) => setAdvancedSearch(event.target.value)}
					/>
					{advanced.map(renderJsonEditor)}
				</details>
				{(reasoning.validationError || error) && (
					<p role="alert" className="text-sm text-status-red">
						{reasoning.validationError ?? error}
					</p>
				)}
				{hasConflict && (
					<div role="status" className="space-y-2 text-sm text-status-orange">
						<p className="m-0">相关默认字段已更新，草稿已保留。请核对上方最新默认后重新确认。</p>
						<Button size="sm" variant="ghost" onClick={() => setBaseline(profile)}>
							根据最新默认重新确认
						</Button>
					</div>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						variant="primary"
						disabled={
							!Object.keys(edits).length ||
							controller.pendingChangeId !== null ||
							hasConflict ||
							Boolean(reasoning.validationError) ||
							Object.keys(advancedDrafts).length > 0
						}
						onClick={() => void save()}
					>
						保存默认并同步
					</Button>
					<Button
						variant="ghost"
						disabled={!dirty}
						onClick={() => {
							setEdits({});
							setAdvancedDrafts({});
							setBaseline(profile);
							setError(null);
							controller.clearHistoricalDefaultEditRequest();
						}}
					>
						放弃草稿
					</Button>
				</div>
				<p className="m-0 text-xs text-text-secondary">
					保存后用于此配置的未来会话；现有会话在原所有者可达或达到安全条件时采用，实际采用以确认记录为准。
				</p>
			</div>
		</details>
	);
}
