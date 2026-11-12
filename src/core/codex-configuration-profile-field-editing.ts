const permissionRootKeys = [
	"approval_policy",
	"approvals_reviewer",
	"sandbox_mode",
	"sandbox_workspace_write",
	"permissions",
];

function isConfigurationTableValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookStateConfigurationField(fieldKey: string) {
	const [, ...keyPath] = JSON.parse(fieldKey) as string[];
	const stateIndex = keyPath.indexOf("state");
	return stateIndex > 0 && keyPath[stateIndex - 1] === "hooks" && keyPath.length === stateIndex + 2;
}

export type CodexConfigurationProfileFieldEdit = { fieldKey: string; value?: unknown; delete?: boolean };

/** 磁盘投影会把非空表展开成叶子。编辑、版本校验和传播必须使用同一表示。 */
export function expandCodexConfigurationProfileFieldEdit(
	edit: CodexConfigurationProfileFieldEdit,
): CodexConfigurationProfileFieldEdit[] {
	if (
		edit.delete ||
		edit.value === undefined ||
		!isConfigurationTableValue(edit.value) ||
		Object.keys(edit.value).length === 0 ||
		isHookStateConfigurationField(edit.fieldKey)
	)
		return [edit];
	const [fileName, ...keyPath] = JSON.parse(edit.fieldKey) as string[];
	if (!fileName || keyPath.length === 0) return [edit];
	const leaves: CodexConfigurationProfileFieldEdit[] = [];
	const visit = (table: Record<string, unknown>, path: string[]) => {
		for (const [key, child] of Object.entries(table)) {
			const childPath = [...path, key];
			const childKey = JSON.stringify([fileName, ...childPath]);
			if (
				isHookStateConfigurationField(childKey) ||
				!isConfigurationTableValue(child) ||
				Object.keys(child).length === 0
			)
				leaves.push({ fieldKey: childKey, value: child });
			else visit(child, childPath);
		}
	};
	visit(edit.value, keyPath);
	return leaves.length > 0 ? leaves : [edit];
}

export function codexConfigurationExceptionGroup(
	fieldKey: string,
): "model" | "reasoning_effort" | "permissions" | undefined {
	const [, ...keyPath] = JSON.parse(fieldKey) as string[];
	const rootKey = keyPath[0] === "profiles" ? keyPath[2] : keyPath[0];
	if (rootKey === "model") return "model";
	if (rootKey === "model_reasoning_effort") return "reasoning_effort";
	if (permissionRootKeys.includes(rootKey ?? "")) return "permissions";
	return undefined;
}

export function codexConfigurationProfileFieldVersionRequirements(
	fieldVersions: Record<string, number>,
	editedFieldKeys: string[],
): Record<string, number | null> {
	const requiredKeys = new Set(editedFieldKeys);
	for (const editedKey of editedFieldKeys) {
		const group = codexConfigurationExceptionGroup(editedKey);
		if (!group) continue;
		const address = JSON.parse(editedKey) as string[];
		const prefix = address.slice(0, address[1] === "profiles" ? 4 : 2);
		prefix.pop();
		for (const root of group === "permissions" ? permissionRootKeys : ["model", "model_reasoning_effort"])
			requiredKeys.add(JSON.stringify([...prefix, root]));
		// 纳入整组已有成员及删除水位，新增权限子项同样会使旧比较失效。
		for (const key of Object.keys(fieldVersions)) {
			const dependencyGroup = codexConfigurationExceptionGroup(key);
			if (
				(JSON.parse(key) as string[]).slice(0, prefix.length).every((part, index) => part === prefix[index]) &&
				(group === "permissions"
					? dependencyGroup === group
					: dependencyGroup === "model" || dependencyGroup === "reasoning_effort")
			)
				requiredKeys.add(key);
		}
	}
	return Object.fromEntries([...requiredKeys].map((key) => [key, fieldVersions[key] ?? null]));
}

export function isCodexLocalStateConfigurationField(fieldKey: string) {
	const [, ...keyPath] = JSON.parse(fieldKey) as string[];
	const path = keyPath[0] === "profiles" ? keyPath.slice(2) : keyPath;
	return (
		path[0] === "desktop" ||
		(path[0] === "tui" && ["model_availability_nux", "screen_reader_detection_done"].includes(path[1] ?? ""))
	);
}
