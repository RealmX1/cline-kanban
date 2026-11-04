import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { fingerprint } from "./experiment-contract";

const packageNameSchema = z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const externalPackageNodeDependencyResolutionBindingSchema = z.object({
	sourcePackageRootDirectory: z.string().startsWith("/"),
	sourcePackageManifestSha256: sha256Schema,
	dependencyPackageName: packageNameSchema,
	optional: z.boolean(),
	resolutionStatus: z.enum(["resolved", "not-installed", "unknown"]),
	resolvedDependencyPackageRootDirectory: z.string().startsWith("/").nullable(),
	resolvedDependencyPackageManifestSha256: sha256Schema.nullable(),
});

export function readDeclaredExternalPackageDependencies(manifestText: string) {
	const manifest = z
		.object({
			dependencies: z.record(packageNameSchema, z.string()).default({}),
			peerDependencies: z.record(packageNameSchema, z.string()).default({}),
			optionalDependencies: z.record(packageNameSchema, z.string()).default({}),
			peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).default({}),
		})
		.parse(JSON.parse(manifestText));
	return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })
		.sort()
		.map((dependencyPackageName) => ({
			dependencyPackageName,
			optional:
				Object.hasOwn(manifest.optionalDependencies, dependencyPackageName) ||
				(!Object.hasOwn(manifest.dependencies, dependencyPackageName) &&
					manifest.peerDependenciesMeta[dependencyPackageName]?.optional === true),
		}));
}

/** 只读取来源，不执行包代码；冻结物理包的 Node 上级搜索关系，不按版本猜测替代包。 */
export async function captureExternalPackageNodeDependencyResolutionBindings(
	installations: { sourcePath: string; packageManifestSha256?: string }[],
) {
	const bindings: z.infer<typeof externalPackageNodeDependencyResolutionBindingSchema>[] = [];
	for (const installation of installations) {
		if (basename(installation.sourcePath) === "node_modules" || !installation.packageManifestSha256) continue;
		const manifestPath = join(installation.sourcePath, "package.json");
		const manifestText = await readFile(manifestPath, "utf8");
		if (fingerprint(manifestText) !== installation.packageManifestSha256)
			throw new Error("外部包来源清单与归档字节不一致，依赖解析关系仍未知");
		const physicalManifestPath = await realpath(manifestPath);
		for (const dependency of readDeclaredExternalPackageDependencies(manifestText)) {
			let resolvedDependencyPackageRootDirectory: string | null = null;
			let resolvedDependencyPackageManifestSha256: string | null = null;
			let unsupportedPackageCandidateObserved = false;
			for (const lookupDirectory of createRequire(physicalManifestPath).resolve.paths(
				dependency.dependencyPackageName,
			) ?? []) {
				const candidateManifestPath = join(lookupDirectory, dependency.dependencyPackageName, "package.json");
				try {
					const physicalDependencyManifestPath = await realpath(candidateManifestPath);
					resolvedDependencyPackageManifestSha256 = fingerprint(await readFile(physicalDependencyManifestPath));
					resolvedDependencyPackageRootDirectory = dirname(physicalDependencyManifestPath);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					try {
						await lstat(dirname(candidateManifestPath));
						unsupportedPackageCandidateObserved = true;
						break;
					} catch (candidateError) {
						if ((candidateError as NodeJS.ErrnoException).code !== "ENOENT") throw candidateError;
					}
				}
			}
			bindings.push({
				sourcePackageRootDirectory: installation.sourcePath,
				sourcePackageManifestSha256: installation.packageManifestSha256,
				...dependency,
				resolutionStatus: resolvedDependencyPackageRootDirectory
					? "resolved"
					: dependency.optional && !unsupportedPackageCandidateObserved
						? "not-installed"
						: "unknown",
				resolvedDependencyPackageRootDirectory,
				resolvedDependencyPackageManifestSha256,
			});
		}
		if (fingerprint(await readFile(manifestPath)) !== installation.packageManifestSha256)
			throw new Error("采集外部包依赖解析期间来源发生变化");
	}
	return bindings;
}
