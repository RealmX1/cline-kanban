import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	prepareCodexDirectoryVolumeObservations,
	prepareCodexPersistentDirectoryIdentity,
} from "../codex-conversation-storage/codex-persistent-directory-identity";
import type {
	CodexConfigurationWriterBinding,
	CodexSourceSharedPluginInstallationDirectoriesBinding,
} from "../core/codex-configuration-sync-contract";

export function codexSourceSharedPluginInstallationIdentityDirectoryPaths(binding: CodexConfigurationWriterBinding) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	return shared ? [shared.pluginsDirectoryCanonicalPath, shared.marketplaceInstallationDirectoryCanonicalPath] : [];
}

async function assertSourceSharedPluginInstallationContainerIdentities(
	sourceHome: string,
	shared: CodexSourceSharedPluginInstallationDirectoriesBinding,
) {
	for (const [relativePath, canonicalPath, identity] of [
		["plugins", shared.pluginsDirectoryCanonicalPath, shared.pluginsDirectoryIdentity],
		[
			".tmp/marketplaces",
			shared.marketplaceInstallationDirectoryCanonicalPath,
			shared.marketplaceInstallationDirectoryIdentity,
		],
	] as const) {
		if (
			(await realpath(join(sourceHome, relativePath))) !== canonicalPath ||
			!(await lstat(canonicalPath)).isDirectory()
		)
			throw new Error(`Codex 共享插件或 marketplace 容器归属被替换：${relativePath}。`);
		await prepareCodexPersistentDirectoryIdentity(canonicalPath, { expectedIdentity: identity });
	}
}

export async function prepareCodexSourceSharedPluginInstallationDirectoriesBinding(input: {
	sourceHome: string;
	existingBindings: CodexConfigurationWriterBinding[];
	nativeCapabilityEvidence: CodexSourceSharedPluginInstallationDirectoriesBinding["nativeCapabilityEvidence"];
}): Promise<CodexSourceSharedPluginInstallationDirectoriesBinding> {
	const existing = input.existingBindings.find(
		(binding) => binding.sourceSharedPluginInstallationDirectoriesBinding,
	)?.sourceSharedPluginInstallationDirectoriesBinding;
	if (existing) {
		await prepareCodexDirectoryVolumeObservations([
			existing.pluginsDirectoryCanonicalPath,
			existing.marketplaceInstallationDirectoryCanonicalPath,
		]);
		await assertSourceSharedPluginInstallationContainerIdentities(input.sourceHome, existing);
		return { ...existing, nativeCapabilityEvidence: input.nativeCapabilityEvidence };
	}
	// 首次绑定允许来源已有的合法软链；之后固定 canonical target 与持久目录身份。
	await mkdir(join(input.sourceHome, "plugins"), { recursive: true, mode: 0o700 });
	await mkdir(join(input.sourceHome, ".tmp", "marketplaces"), { recursive: true, mode: 0o700 });
	const pluginsDirectoryCanonicalPath = await realpath(join(input.sourceHome, "plugins"));
	const marketplaceInstallationDirectoryCanonicalPath = await realpath(join(input.sourceHome, ".tmp", "marketplaces"));
	await prepareCodexDirectoryVolumeObservations([
		pluginsDirectoryCanonicalPath,
		marketplaceInstallationDirectoryCanonicalPath,
	]);
	return {
		layoutVersion: 1,
		pluginsDirectoryCanonicalPath,
		marketplaceInstallationDirectoryCanonicalPath,
		pluginsDirectoryIdentity: await prepareCodexPersistentDirectoryIdentity(pluginsDirectoryCanonicalPath),
		marketplaceInstallationDirectoryIdentity: await prepareCodexPersistentDirectoryIdentity(
			marketplaceInstallationDirectoryCanonicalPath,
		),
		nativeCapabilityEvidence: input.nativeCapabilityEvidence,
	};
}

export async function linkCodexSourceSharedPluginInstallationDirectories(
	sourceHome: string,
	configurationHome: string,
	shared: CodexSourceSharedPluginInstallationDirectoriesBinding,
) {
	await assertSourceSharedPluginInstallationContainerIdentities(sourceHome, shared);
	await mkdir(join(configurationHome, ".tmp"), { mode: 0o700 });
	await symlink(shared.pluginsDirectoryCanonicalPath, join(configurationHome, "plugins"), "junction");
	await symlink(
		shared.marketplaceInstallationDirectoryCanonicalPath,
		join(configurationHome, ".tmp", "marketplaces"),
		"junction",
	);
}

export async function assertCodexSourceSharedPluginInstallationDirectoriesBinding(
	binding: CodexConfigurationWriterBinding,
) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) return;
	const temporaryRoot = await lstat(join(binding.configurationHomeDirectoryPath, ".tmp"));
	if (!temporaryRoot.isDirectory() || temporaryRoot.isSymbolicLink())
		throw new Error("Codex writer 的 .tmp 必须为普通目录，只允许共享 marketplaces 子目录。");
	for (const [relativePath, target] of [
		["plugins", shared.pluginsDirectoryCanonicalPath],
		[".tmp/marketplaces", shared.marketplaceInstallationDirectoryCanonicalPath],
	] as const) {
		const bridge = join(binding.configurationHomeDirectoryPath, relativePath);
		if (!(await lstat(bridge)).isSymbolicLink() || resolve(dirname(bridge), await readlink(bridge)) !== target)
			throw new Error(`Codex 共享插件或 marketplace 桥接被替换：${relativePath}。`);
	}
	await assertSourceSharedPluginInstallationContainerIdentities(binding.sourceHomeDirectoryPath, shared);
}
