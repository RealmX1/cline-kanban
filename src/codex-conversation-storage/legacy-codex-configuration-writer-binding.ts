import { lstat, readFile, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import type { z } from "zod";
import { legacyCodexConfigurationWriterBindingSchema } from "../core/legacy-codex-configuration-writer-binding-schema";
import { formatCodexConfigurationOverrideTomlValue } from "./codex-native-configuration-override-toml-value";
import { prepareCodexPersistentDirectoryIdentity } from "./codex-persistent-directory-identity";

type LegacyCodexConfigurationWriterBinding = z.infer<typeof legacyCodexConfigurationWriterBindingSchema>;

import { dirname, join } from "node:path";
import { getRuntimeHomePath } from "../state/runtime-home-path";

export const getLegacyCodexConfigurationDirectory = () =>
	join(getRuntimeHomePath(), "codex-configuration-writer-bindings-and-sync");

export async function readLegacyCodexWriterResumeSettings(input: {
	binding: LegacyCodexConfigurationWriterBinding;
	workspaceId: string;
	conversationSessionId: string;
	runtimeSessionIncarnationId?: string;
	storageHome: string;
	preserveProfilePermissions: boolean;
}) {
	const binding = input.binding;
	const expectedConfigurationHome = join(
		getLegacyCodexConfigurationDirectory(),
		"writers",
		binding.writerId,
		"configuration-home",
	);
	const physicalConfigurationHome = await realpath(expectedConfigurationHome);
	const physicalWritersRoot = await realpath(join(getLegacyCodexConfigurationDirectory(), "writers"));
	if (
		physicalConfigurationHome !== join(physicalWritersRoot, binding.writerId, "configuration-home") ||
		physicalConfigurationHome !== binding.configurationHomeDirectoryPath ||
		binding.purpose !== "native_session" ||
		binding.workspaceId !== input.workspaceId ||
		binding.conversationSessionId !== input.conversationSessionId ||
		binding.runtimeSessionIncarnationId !== input.runtimeSessionIncarnationId ||
		(await realpath(input.storageHome)) !== binding.conversationStorageHomeDirectoryPath
	)
		throw new Error("旧 Codex 配置清单与会话或历史目录不符，保留原会话。");
	const manifestPath = join(dirname(physicalConfigurationHome), "writer-binding.json");
	if (!(await lstat(manifestPath)).isFile()) throw new Error("旧 Codex 配置清单不是普通文件。");
	const manifest = legacyCodexConfigurationWriterBindingSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
	if (!isDeepStrictEqual(binding, manifest)) throw new Error("旧 Codex 配置清单与持久会话记录不符。");
	await Promise.all(
		(
			[
				[binding.sourceHomeDirectoryPath, binding.sourceIdentity],
				[binding.conversationStorageHomeDirectoryPath, binding.storageDirectoryIdentity],
				[binding.sqliteHomeDirectoryPath, binding.sqliteDirectoryIdentity],
			] as const
		).map(([path, expectedIdentity]) =>
			prepareCodexPersistentDirectoryIdentity(path, {
				expectedIdentity,
				boundAtMs: binding.createdAt,
				legacyBindingManifestPath: manifestPath,
			}),
		),
	);
	const configurationPath = join(physicalConfigurationHome, "config.toml");
	if (!(await lstat(configurationPath)).isFile()) throw new Error("旧 Codex 配置不是普通文件。");
	const configuration = parse(await readFile(configurationPath, "utf8"));
	const permissionArguments: string[] = [];
	if (input.preserveProfilePermissions) {
		const approval = configuration.approval_policy;
		const sandbox = configuration.sandbox_mode;
		const hasCompletePermissionSelection =
			approval !== undefined &&
			(sandbox !== undefined ||
				(configuration.permissions !== undefined && configuration.default_permissions !== undefined));
		if (!hasCompletePermissionSelection || approval === "untrusted") {
			// 不完整选择和已退役的 untrusted 都没有可信的完整权限。只读沙箱外的操作必须经过原生询问，
			// 不能用 never 直接拒绝，也不能保留更宽的沙箱。
			permissionArguments.push(
				"--sandbox",
				"read-only",
				"--ask-for-approval",
				"on-request",
				"-c",
				'approvals_reviewer="user"',
			);
		} else {
			for (const key of [
				"approval_policy",
				"approvals_reviewer",
				"sandbox_mode",
				"sandbox_workspace_write",
				"permissions",
				"default_permissions",
			])
				if (configuration[key] !== undefined)
					permissionArguments.push(
						"-c",
						`${key}=${formatCodexConfigurationOverrideTomlValue(configuration[key])}`,
					);
		}
	}
	return {
		model: typeof configuration.model === "string" ? configuration.model : undefined,
		reasoningEffort:
			typeof configuration.model_reasoning_effort === "string" ? configuration.model_reasoning_effort : undefined,
		permissionArguments,
		sqliteHomeDirectoryPath: binding.sqliteHomeDirectoryPath,
		sqliteDirectoryIdentity: binding.sqliteDirectoryIdentity,
	};
}
