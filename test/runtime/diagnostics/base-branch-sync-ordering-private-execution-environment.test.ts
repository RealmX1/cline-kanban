import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendTaskDependencyEnvironmentBackups,
	backupExecutionEnvironment,
} from "../../../scripts/base-branch-sync-ordering-experiment/execution-environment-backup";
import { fingerprint } from "../../../scripts/base-branch-sync-ordering-experiment/experiment-contract";
import { createOwnedExperimentRoot } from "../../../scripts/base-branch-sync-ordering-experiment/persistent-experiment-storage";
import {
	captureSupplementalExternalPackageNodeResolutionEvidence,
	restoreExecutionEnvironmentIntoPrivateDirectories,
} from "../../../scripts/base-branch-sync-ordering-experiment/restore-execution-environment";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function prepareExternalPackageAncestorDependencyArchiveFixture(archiveExternalPackageViaAppend = false) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const root = fixture.ownedIntegrationProjectsDirectoryPath;
	const archiveRoot = join(root, "external-package-ancestry-archive");
	await createOwnedExperimentRoot(archiveRoot, join(root, "original-repository.git"));
	const sourceProject = join(root, "original-consumer-project");
	const sourceInstallation = join(sourceProject, "node_modules");
	const externalPackage = join(sourceProject, ".plan", "locked-external-package");
	mkdirSync(join(sourceInstallation, "fixture-dependency"), { recursive: true });
	mkdirSync(join(externalPackage, "node_modules", "@fixture", "own-dependency"), { recursive: true });
	writeFileSync(
		join(sourceInstallation, "fixture-dependency", "package.json"),
		JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
	);
	writeFileSync(join(sourceInstallation, "fixture-dependency", "index.js"), "module.exports = 40;\n");
	writeFileSync(
		join(externalPackage, "node_modules", "@fixture", "own-dependency", "package.json"),
		JSON.stringify({ name: "@fixture/own-dependency", main: "index.js" }),
	);
	writeFileSync(
		join(externalPackage, "node_modules", "@fixture", "own-dependency", "index.js"),
		"module.exports = 2;\n",
	);
	writeFileSync(
		join(externalPackage, "package.json"),
		JSON.stringify({
			name: "fixture-external-consumer",
			type: "module",
			exports: "./index.js",
			dependencies: { "fixture-dependency": "1.0.0", "@fixture/own-dependency": "1.0.0" },
		}),
	);
	writeFileSync(
		join(externalPackage, "index.js"),
		'import dependency from "fixture-dependency"; import ownDependency from "@fixture/own-dependency"; process.stdout.write(String(dependency + ownDependency));\n',
	);
	symlinkSync(externalPackage, join(sourceInstallation, "fixture-external-consumer"));
	const inputPath = join(archiveRoot, "external-package-backup-input.json");
	writeFileSync(
		inputPath,
		JSON.stringify({
			schemaVersion: 1,
			directories: [
				{ sourcePath: sourceInstallation, destinationName: "runtime" },
				...(archiveExternalPackageViaAppend
					? []
					: [{ sourcePath: externalPackage, destinationName: "external-package" }]),
			],
			executables: [],
		}),
	);
	await backupExecutionEnvironment(inputPath, archiveRoot);
	const taskDependencyBindingsPath = join(archiveRoot, "external-package-task-dependency-bindings.json");
	writeFileSync(taskDependencyBindingsPath, JSON.stringify({ [externalPackage]: ["fixture:external-package"] }));
	if (archiveExternalPackageViaAppend)
		await appendTaskDependencyEnvironmentBackups(archiveRoot, taskDependencyBindingsPath);
	return {
		fixture,
		root,
		archiveRoot,
		sourceProject,
		sourceInstallation,
		externalPackage,
		inputPath,
		taskDependencyBindingsPath,
	};
}

describe("从共同依赖归档恢复独立实验组的可执行安装", () => {
	it.each([false, true])(
		"外部包保留上级 Node 依赖解析，自有 node_modules 保留，append=%s",
		async (archiveExternalPackageViaAppend) => {
			const { fixture, archiveRoot, sourceProject, taskDependencyBindingsPath } =
				await prepareExternalPackageAncestorDependencyArchiveFixture(archiveExternalPackageViaAppend);
			const manifestPath = join(archiveRoot, "execution-environment", "execution-environment-backup-manifest.json");
			const manifestBytes = readFileSync(manifestPath);
			renameSync(sourceProject, `${sourceProject}-unavailable-during-restoration`);
			await appendTaskDependencyEnvironmentBackups(archiveRoot, taskDependencyBindingsPath);
			expect(readFileSync(manifestPath)).toEqual(manifestBytes);
			const restored = join(archiveRoot, "private-dependency-installations");
			await restoreExecutionEnvironmentIntoPrivateDirectories(archiveRoot, restored);
			const privatePackage = realpathSync(join(restored, "runtime", "node_modules", "fixture-external-consumer"));
			expect(
				execFileSync(process.execPath, [join(privatePackage, "index.js")], {
					env: fixture.createIsolatedChildProcessEnvironment(),
					encoding: "utf8",
				}).trim(),
			).toBe("42");
			expect(
				readFileSync(join(privatePackage, "node_modules", "@fixture", "own-dependency", "index.js"), "utf8"),
			).toBe("module.exports = 2;\n");
			const receiptPath = join(restored, "private-environment-restoration-verification.json");
			const receiptText = readFileSync(receiptPath, "utf8");
			const receipt = JSON.parse(receiptText);
			expect(receipt.externalPackageNodeDependencyResolutionBindings).toHaveLength(2);
			expect(receipt.externalPackageNodeDependencyResolutionBindingsSha256).toBe(
				fingerprint(JSON.stringify(receipt.externalPackageNodeDependencyResolutionBindings)),
			);
			await restoreExecutionEnvironmentIntoPrivateDirectories(archiveRoot, restored);
			expect(readFileSync(receiptPath, "utf8")).toBe(receiptText);
		},
	);

	it("旧归档解析缺证先拒绝，同源独立补证后离线恢复且不改归档", async () => {
		const { fixture, root, archiveRoot, sourceProject } =
			await prepareExternalPackageAncestorDependencyArchiveFixture();
		const manifestPath = join(archiveRoot, "execution-environment", "execution-environment-backup-manifest.json");
		const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		delete legacyManifest.externalPackageNodeDependencyResolutionBindings;
		writeFileSync(manifestPath, JSON.stringify(legacyManifest));
		const originalManifestBytes = readFileSync(manifestPath);
		const restorationRoot = join(root, "legacy-external-package-restoration-arm");
		await createOwnedExperimentRoot(restorationRoot, join(root, "original-repository.git"));
		const restored = join(restorationRoot, "private-dependency-installations");
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(restorationRoot, restored, archiveRoot),
		).rejects.toThrow("依赖解析关系未知或不唯一");
		expect(existsSync(restored)).toBe(false);
		const evidence = await captureSupplementalExternalPackageNodeResolutionEvidence(
			restorationRoot,
			archiveRoot,
			join(restorationRoot, "legacy-external-package-node-resolution-evidence.json"),
		);
		renameSync(sourceProject, `${sourceProject}-unavailable-during-restoration`);
		await restoreExecutionEnvironmentIntoPrivateDirectories(restorationRoot, restored, archiveRoot, evidence);
		const privatePackage = realpathSync(join(restored, "runtime", "node_modules", "fixture-external-consumer"));
		expect(
			execFileSync(process.execPath, [join(privatePackage, "index.js")], {
				env: fixture.createIsolatedChildProcessEnvironment(),
				encoding: "utf8",
			}).trim(),
		).toBe("42");
		expect(readFileSync(manifestPath)).toEqual(originalManifestBytes);
		const receipt = JSON.parse(
			readFileSync(join(restored, "private-environment-restoration-verification.json"), "utf8"),
		);
		expect(receipt.supplementalExternalPackageNodeResolutionEvidence).toEqual(evidence);
		writeFileSync(evidence.path, `${readFileSync(evidence.path, "utf8")} `);
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(restorationRoot, restored, archiveRoot, evidence),
		).rejects.toThrow("补充原件摘要变化");
	});

	it.each(["source-code-drift", "dependency-code-drift", "additional-source-file", "unarchived-resolution-target"])(
		"旧归档补证拒绝 %s，不伪造完整解析资格",
		async (driftKind) => {
			const { archiveRoot, sourceInstallation, externalPackage } =
				await prepareExternalPackageAncestorDependencyArchiveFixture();
			const manifestPath = join(archiveRoot, "execution-environment", "execution-environment-backup-manifest.json");
			const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			delete legacyManifest.externalPackageNodeDependencyResolutionBindings;
			writeFileSync(manifestPath, JSON.stringify(legacyManifest));
			if (driftKind === "source-code-drift")
				writeFileSync(join(externalPackage, "index.js"), "throw new Error('changed');\n");
			if (driftKind === "dependency-code-drift")
				writeFileSync(join(sourceInstallation, "fixture-dependency", "index.js"), "module.exports = 99;\n");
			if (driftKind === "additional-source-file")
				writeFileSync(join(externalPackage, "unarchived-source.js"), "module.exports = 99;\n");
			if (driftKind === "unarchived-resolution-target") {
				const nearerDependency = join(externalPackage, "node_modules", "fixture-dependency");
				mkdirSync(nearerDependency);
				writeFileSync(
					join(nearerDependency, "package.json"),
					JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
				);
				writeFileSync(join(nearerDependency, "index.js"), "module.exports = 99;\n");
			}
			const evidencePath = join(archiveRoot, "rejected-external-package-node-resolution-evidence.json");
			await expect(
				captureSupplementalExternalPackageNodeResolutionEvidence(archiveRoot, archiveRoot, evidencePath),
			).rejects.toThrow("与归档内容不一致");
			expect(existsSync(evidencePath)).toBe(false);
		},
	);

	it.each(["missing-binding", "duplicate-binding", "unarchived-target", "target-manifest-drift"])(
		"恢复前拒绝 %s，未创建成功回执或私有安装",
		async (bindingMutation) => {
			const { archiveRoot } = await prepareExternalPackageAncestorDependencyArchiveFixture();
			const manifestPath = join(archiveRoot, "execution-environment", "execution-environment-backup-manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			const bindings = manifest.externalPackageNodeDependencyResolutionBindings;
			if (bindingMutation === "missing-binding") bindings.pop();
			if (bindingMutation === "duplicate-binding") bindings.push(bindings[0]);
			if (bindingMutation === "unarchived-target")
				bindings[0].resolvedDependencyPackageRootDirectory = join(archiveRoot, "undeclared-package");
			if (bindingMutation === "target-manifest-drift")
				bindings[0].resolvedDependencyPackageManifestSha256 = "0".repeat(64);
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const restored = join(archiveRoot, "rejected-private-installation");
			await expect(restoreExecutionEnvironmentIntoPrivateDirectories(archiveRoot, restored)).rejects.toThrow(
				/未知或不唯一|未被同源归档/u,
			);
			expect(existsSync(restored)).toBe(false);
		},
	);

	it("外部包已有 node_modules 目录链接时保留原链接闭包", async () => {
		const { fixture, root, archiveRoot, sourceProject, sourceInstallation, externalPackage } =
			await prepareExternalPackageAncestorDependencyArchiveFixture();
		const ownInstallation = join(sourceProject, "external-own-installation", "node_modules");
		mkdirSync(join(sourceProject, "external-own-installation"));
		renameSync(join(externalPackage, "node_modules"), ownInstallation);
		symlinkSync(ownInstallation, join(externalPackage, "node_modules"));
		const linkedArchive = join(root, "external-own-linked-installation-archive");
		await createOwnedExperimentRoot(linkedArchive, join(root, "original-repository.git"));
		const inputPath = join(archiveRoot, "external-own-linked-installation-backup-input.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				schemaVersion: 1,
				directories: [
					{ sourcePath: sourceInstallation, destinationName: "runtime" },
					{ sourcePath: externalPackage, destinationName: "external-package" },
					{ sourcePath: ownInstallation, destinationName: "external-own-installation" },
				],
				executables: [],
			}),
		);
		await backupExecutionEnvironment(inputPath, linkedArchive);
		renameSync(sourceProject, `${sourceProject}-unavailable-during-restoration`);
		const restored = join(linkedArchive, "private-dependency-installations");
		await restoreExecutionEnvironmentIntoPrivateDirectories(linkedArchive, restored);
		const privatePackage = realpathSync(join(restored, "runtime", "node_modules", "fixture-external-consumer"));
		expect(
			execFileSync(process.execPath, [join(privatePackage, "index.js")], {
				env: fixture.createIsolatedChildProcessEnvironment(),
				encoding: "utf8",
			}).trim(),
		).toBe("42");
	});

	it.each(["missing-required", "optional-not-installed", "closer-package-without-manifest"])(
		"依赖快照如实记录 %s，未知解析不生成成功回执",
		async (resolutionKind) => {
			const { root, archiveRoot, externalPackage, inputPath } =
				await prepareExternalPackageAncestorDependencyArchiveFixture();
			const packagePath = join(externalPackage, "package.json");
			const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"));
			if (resolutionKind === "missing-required")
				packageManifest.dependencies["uninstalled-required-dependency"] = "1.0.0";
			if (resolutionKind === "optional-not-installed")
				packageManifest.optionalDependencies = { "uninstalled-optional-dependency": "1.0.0" };
			if (resolutionKind === "closer-package-without-manifest") {
				const nearerDependency = join(externalPackage, "node_modules", "fixture-dependency");
				mkdirSync(nearerDependency);
				writeFileSync(join(nearerDependency, "index.js"), "module.exports = 99;\n");
			}
			writeFileSync(packagePath, JSON.stringify(packageManifest));
			const verificationArchive = join(root, "external-package-resolution-status-archive");
			await createOwnedExperimentRoot(verificationArchive, join(root, "original-repository.git"));
			await backupExecutionEnvironment(inputPath, verificationArchive);
			const restored = join(verificationArchive, "private-dependency-installations");
			if (resolutionKind === "optional-not-installed") {
				await restoreExecutionEnvironmentIntoPrivateDirectories(verificationArchive, restored);
				const receipt = JSON.parse(
					readFileSync(join(restored, "private-environment-restoration-verification.json"), "utf8"),
				);
				expect(receipt.externalPackageNodeDependencyResolutionBindings).toContainEqual(
					expect.objectContaining({
						dependencyPackageName: "uninstalled-optional-dependency",
						resolutionStatus: "not-installed",
					}),
				);
			} else {
				await expect(
					restoreExecutionEnvironmentIntoPrivateDirectories(verificationArchive, restored),
				).rejects.toThrow("依赖解析仍未知");
				expect(existsSync(restored)).toBe(false);
			}
			expect(
				existsSync(join(archiveRoot, "execution-environment", "execution-environment-backup-manifest.json")),
			).toBe(true);
		},
	);

	it.each([
		"symlink-to-archive",
		"hardlink-to-original",
		"hardlink-to-archive",
		"executable-hardlink",
		"executable-parent-symlink",
	])("既有目标 %s 在 chmod 或写入前拒绝，来源权限及字节不变", async (destinationKind) => {
		const executableDestination = destinationKind.startsWith("executable-");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = fixture.ownedIntegrationProjectsDirectoryPath;
		const archiveRoot = join(root, "protected-dependency-archive");
		const armRoot = join(root, "private-recovery-arm");
		for (const ownedRoot of [archiveRoot, armRoot])
			await createOwnedExperimentRoot(ownedRoot, join(root, "original-repository.git"));
		const sourceInstallation = join(root, "original-installation");
		mkdirSync(sourceInstallation);
		const originalFile = join(
			sourceInstallation,
			executableDestination ? "protected-executable" : "protected-source.js",
		);
		writeFileSync(originalFile, "module.exports = 42;\n");
		const inputPath = join(archiveRoot, "dependency-backup-input.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				schemaVersion: 1,
				directories: executableDestination ? [] : [{ sourcePath: sourceInstallation, destinationName: "runtime" }],
				executables: executableDestination
					? [{ sourcePath: originalFile, destinationName: "protected-executable" }]
					: [],
			}),
		);
		await backupExecutionEnvironment(inputPath, archiveRoot);
		const archivedFile = join(
			archiveRoot,
			"execution-environment",
			...(executableDestination ? ["protected-executable"] : ["runtime", "protected-source.js"]),
		);
		const target = join(armRoot, "private-dependency-installations");
		const destination = join(
			target,
			...(executableDestination ? ["executables", "protected-executable"] : ["runtime", "protected-source.js"]),
		);
		mkdirSync(
			destinationKind === "executable-parent-symlink"
				? target
				: join(target, executableDestination ? "executables" : "runtime"),
			{
				recursive: true,
			},
		);
		const protectedSource =
			destinationKind === "symlink-to-archive" || destinationKind === "hardlink-to-archive"
				? archivedFile
				: originalFile;
		if (destinationKind === "executable-parent-symlink") symlinkSync(sourceInstallation, join(target, "executables"));
		else if (destinationKind === "symlink-to-archive") symlinkSync(protectedSource, destination);
		else linkSync(protectedSource, destination);
		chmodSync(protectedSource, 0o400);
		const originalBytes = readFileSync(protectedSource);
		await expect(restoreExecutionEnvironmentIntoPrivateDirectories(armRoot, target, archiveRoot)).rejects.toThrow(
			/独立依赖副本|符号链接/u,
		);
		expect(statSync(protectedSource).mode & 0o777).toBe(0o400);
		expect(readFileSync(protectedSource)).toEqual(originalBytes);
		expect(existsSync(join(target, "private-environment-restoration-verification.json"))).toBe(false);
	});

	it("跨 owned root 保留 Node 解析与链接，组内写入不改变另一组或归档，重入拒绝漂移", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = fixture.ownedIntegrationProjectsDirectoryPath;
		const originalCommonDirectory = join(root, "original-repository.git");
		const archiveRoot = join(root, "archived-execution-environment");
		const firstArmRoot = join(root, "first-isolated-experiment-arm");
		const secondArmRoot = join(root, "second-isolated-experiment-arm");
		for (const experimentRoot of [archiveRoot, firstArmRoot, secondArmRoot])
			await createOwnedExperimentRoot(experimentRoot, originalCommonDirectory);
		const sourceInstallation = join(root, "source-installation", "node_modules");
		for (const path of ["fixture-consumer", "fixture-dependency", ".bin"])
			mkdirSync(join(sourceInstallation, path), { recursive: true });
		writeFileSync(
			join(sourceInstallation, "fixture-consumer", "index.js"),
			'process.stdout.write(String(require("fixture-dependency")) + "\\n");\n',
		);
		writeFileSync(join(sourceInstallation, "fixture-dependency", "index.js"), "module.exports = 42;\n");
		symlinkSync("../fixture-consumer/index.js", join(sourceInstallation, ".bin", "read-fixture-dependency"));
		const inputPath = join(archiveRoot, "execution-environment-backup-input.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				schemaVersion: 1,
				directories: [{ sourcePath: sourceInstallation, destinationName: "runtime" }],
				executables: [],
			}),
		);
		await backupExecutionEnvironment(inputPath, archiveRoot);
		const firstTarget = join(firstArmRoot, "private-dependency-installations");
		const secondTarget = join(secondArmRoot, "private-dependency-installations");
		await restoreExecutionEnvironmentIntoPrivateDirectories(firstArmRoot, firstTarget, archiveRoot);
		await restoreExecutionEnvironmentIntoPrivateDirectories(secondArmRoot, secondTarget, archiveRoot);
		const output = (installation: string) =>
			execFileSync(process.execPath, [join(installation, ".bin", "read-fixture-dependency")], {
				env: fixture.createIsolatedChildProcessEnvironment(),
				encoding: "utf8",
			}).trim();
		const firstInstallation = join(firstTarget, "runtime", "node_modules");
		const secondInstallation = join(secondTarget, "runtime", "node_modules");
		expect(output(firstInstallation)).toBe("42");
		expect(output(secondInstallation)).toBe("42");
		const archivedDependency = join(
			archiveRoot,
			"execution-environment",
			"runtime",
			"fixture-dependency",
			"index.js",
		);
		const firstDependency = join(firstInstallation, "fixture-dependency", "index.js");
		const secondDependency = join(secondInstallation, "fixture-dependency", "index.js");
		expect(statSync(firstDependency).ino).not.toBe(statSync(archivedDependency).ino);
		expect(statSync(firstDependency).ino).not.toBe(statSync(secondDependency).ino);
		writeFileSync(firstDependency, "module.exports = 84;\n");
		expect(output(firstInstallation)).toBe("84");
		expect(output(secondInstallation)).toBe("42");
		expect(readFileSync(archivedDependency, "utf8")).toBe("module.exports = 42;\n");
		expect(output(sourceInstallation)).toBe("42");
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(firstArmRoot, firstTarget, archiveRoot),
		).rejects.toThrow("独立依赖副本");
		expect(output(firstInstallation)).toBe("84");
		const receipt = JSON.parse(
			readFileSync(join(secondTarget, "private-environment-restoration-verification.json"), "utf8"),
		);
		expect(receipt.sourceArchiveExperimentRootDirectory).toBe(archiveRoot);
		expect(receipt.targetExperimentRootDirectory).toBe(secondArmRoot);
		expect(receipt.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("默认双参恢复仍有效，拒绝不相关归档、目标越界及覆盖归档", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const root = fixture.ownedIntegrationProjectsDirectoryPath;
		const archiveRoot = join(root, "original-archive-root");
		const otherRoot = join(root, "unrelated-experiment-root");
		await createOwnedExperimentRoot(archiveRoot, join(root, "original-repository.git"));
		await createOwnedExperimentRoot(otherRoot, join(root, "another-repository.git"));
		const inputPath = join(archiveRoot, "empty-environment-backup-input.json");
		writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, directories: [], executables: [] }));
		await backupExecutionEnvironment(inputPath, archiveRoot);
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(
				archiveRoot,
				join(archiveRoot, "default-private-installation"),
			),
		).resolves.toEqual({ directoryCount: 0, mappedSymlinkCount: 0 });
		const unrelatedTarget = join(otherRoot, "private-dependency-installations");
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(otherRoot, unrelatedTarget, archiveRoot),
		).rejects.toThrow("同一来源仓库");
		expect(existsSync(unrelatedTarget)).toBe(false);
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(archiveRoot, join(root, "outside-owned-root"), archiveRoot),
		).rejects.toThrow("所有权");
		await expect(
			restoreExecutionEnvironmentIntoPrivateDirectories(archiveRoot, join(archiveRoot, "execution-environment")),
		).rejects.toThrow("覆盖依赖归档");
	});
});
