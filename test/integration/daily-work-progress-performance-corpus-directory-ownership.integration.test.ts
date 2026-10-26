import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const experimentScriptPath = fileURLToPath(
	new URL("../../scripts/daily-work-progress-performance-experiment.ts", import.meta.url),
);

function generateFixedCorpus(fixture: IsolatedGitTestWorkspaceFixture, corpusDirectory: string) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			experimentScriptPath,
			"--command",
			"generate",
			"--corpus-directory",
			corpusDirectory,
			"--project-count",
			"1",
			"--record-count",
			"1000",
			"--receipt-count",
			"1000",
		],
		{
			cwd: dirname(dirname(experimentScriptPath)),
			env: fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "codex-configuration"),
				CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "codex-sqlite"),
			}),
			encoding: "utf8",
			timeout: 60_000,
		},
	);
}

async function snapshotDirectoryFileHashes(directory: string): Promise<Record<string, string>> {
	const fileHashes: Record<string, string> = {};
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [relativePath, sha256] of Object.entries(await snapshotDirectoryFileHashes(entryPath))) {
				fileHashes[join(entry.name, relativePath)] = sha256;
			}
		} else {
			fileHashes[entry.name] = createHash("sha256")
				.update(await readFile(entryPath))
				.digest("hex");
		}
	}
	return fileHashes;
}

describe("固定性能语料目录独占", { timeout: 180_000 }, () => {
	it.each(["空目录", "仅含哨兵和旧转录的目录"])("拒绝已有%s且文件字节保持不变", async (existingDirectoryKind) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const corpusDirectory = join(fixture.fixtureRootDirectoryPath, "existing-corpus-directory");
		await mkdir(corpusDirectory);
		if (existingDirectoryKind !== "空目录") {
			await writeFile(join(corpusDirectory, "evidence-sentinel.txt"), "旧实验哨兵，必须保留\n");
			await mkdir(join(corpusDirectory, "transcripts"));
			await writeFile(join(corpusDirectory, "transcripts", "old-session.jsonl"), '{"旧转录":"必须保留"}\n');
		}
		const before = await snapshotDirectoryFileHashes(corpusDirectory);
		const generated = generateFixedCorpus(fixture, corpusDirectory);
		expect(await snapshotDirectoryFileHashes(corpusDirectory)).toEqual(before);
		expect(generated.status, generated.stderr).not.toBe(0);
		expect(generated.stderr).toContain("EEXIST");
	});

	it("新建嵌套语料目录并拒绝覆盖已生成的语料", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const corpusDirectory = join(fixture.fixtureRootDirectoryPath, "new-parent-directory", "new-corpus-directory");
		const generated = generateFixedCorpus(fixture, corpusDirectory);
		expect(generated.status, generated.stderr).toBe(0);
		const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ projectCount: 1, recordCount: 1000, receiptCount: 1000 });
		expect(manifest.files.length).toBeGreaterThan(1000);
		for (const file of manifest.files) {
			const contents = await readFile(join(corpusDirectory, file.path));
			expect(contents.byteLength).toBe(file.bytes);
			expect(createHash("sha256").update(contents).digest("hex")).toBe(file.sha256);
		}
		await writeFile(join(corpusDirectory, "manifest.json"), "保留既有清单原始字节\n");
		const before = await snapshotDirectoryFileHashes(corpusDirectory);
		const regenerated = generateFixedCorpus(fixture, corpusDirectory);
		expect(await snapshotDirectoryFileHashes(corpusDirectory)).toEqual(before);
		expect(regenerated.status, regenerated.stderr).not.toBe(0);
		expect(regenerated.stderr).toContain("EEXIST");
	});
});
