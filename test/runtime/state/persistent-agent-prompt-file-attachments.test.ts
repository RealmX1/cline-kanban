import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { savePersistentAgentPromptFileAttachment } from "../../../src/state/persistent-agent-prompt-file-attachments";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const isolatedRuntimeHome = vi.hoisted(() => ({ directoryPath: "" }));
vi.mock("../../../src/state/runtime-home-path", () => ({
	getRuntimeHomePath: () => isolatedRuntimeHome.directoryPath,
}));

it("持久保存任意文件字节、原文件名和扩展名，重复上传不会覆盖文件", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	isolatedRuntimeHome.directoryPath = fixture.isolatedHomeDirectoryPath;
	const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
	const input = { fileName: "报告 参考.pdf", fileContentBase64: bytes.toString("base64") };
	const saved = await savePersistentAgentPromptFileAttachment(input);
	expect(saved.fileName).toBe(input.fileName);
	expect(isAbsolute(saved.filePath)).toBe(true);
	expect(saved.filePath.endsWith(".pdf")).toBe(true);
	expect((await readFile(saved.filePath)).equals(bytes)).toBe(true);
	expect((await stat(saved.filePath)).mode & 0o777).toBe(0o600);
	const next = await savePersistentAgentPromptFileAttachment(input);
	expect(next.filePath).not.toBe(saved.filePath);
	expect((await readFile(JSON.parse(JSON.stringify(saved)).filePath)).equals(bytes)).toBe(true);
});

it("允许空文件和恰好 20MB 的文件", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	isolatedRuntimeHome.directoryPath = fixture.isolatedHomeDirectoryPath;
	const empty = await savePersistentAgentPromptFileAttachment({ fileName: "empty", fileContentBase64: "" });
	expect(await readFile(empty.filePath)).toHaveLength(0);
	const bytes = Buffer.alloc(20 * 1024 * 1024, 42);
	const saved = await savePersistentAgentPromptFileAttachment({
		fileName: "limit.bin",
		fileContentBase64: bytes.toString("base64"),
	});
	expect((await readFile(saved.filePath)).equals(bytes)).toBe(true);
});

it.each(["x".repeat(220), "x".repeat(253), "中".repeat(84)])(
	"合法长扩展名上传后保持完整，生成文件名不超过源文件名的字节长度：%s",
	async (extensionWithoutDot) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		isolatedRuntimeHome.directoryPath = fixture.isolatedHomeDirectoryPath;
		const fileName = `a.${extensionWithoutDot}`;
		const sourcePath = join(fixture.isolatedHomeDirectoryPath, fileName);
		const bytes = Buffer.from("长扩展名附件");
		await writeFile(sourcePath, bytes);
		const saved = await savePersistentAgentPromptFileAttachment({
			fileName,
			fileContentBase64: (await readFile(sourcePath)).toString("base64"),
		});
		expect(saved.fileName).toBe(fileName);
		expect(extname(saved.filePath)).toBe(extname(fileName));
		expect(Buffer.byteLength(basename(saved.filePath))).toBeLessThanOrEqual(Buffer.byteLength(fileName));
		expect((await readFile(saved.filePath)).equals(bytes)).toBe(true);
	},
);

it("拒绝超限与非标准 base64，不留下附件文件", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	isolatedRuntimeHome.directoryPath = fixture.isolatedHomeDirectoryPath;
	for (const fileContentBase64 of [
		"?",
		"aQ",
		"aQ==\n",
		"aR==",
		"data:text/plain;base64,aQ==",
		Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64"),
	]) {
		await expect(
			savePersistentAgentPromptFileAttachment({ fileName: "bad.bin", fileContentBase64 }),
		).rejects.toThrow();
	}
	await expect(
		readdir(join(isolatedRuntimeHome.directoryPath, "persistent-agent-prompt-file-attachments")),
	).rejects.toMatchObject({ code: "ENOENT" });
});

it("客户端文件名不能指定服务器路径", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	isolatedRuntimeHome.directoryPath = fixture.isolatedHomeDirectoryPath;
	for (const fileName of [
		"../../outside.txt",
		"/absolute/outside.txt",
		"C:\\outside\\file.txt",
		"../中文 参考.md",
		`../a.${"x".repeat(220)}`,
		`C:\\outside\\a.${"x".repeat(220)}`,
		".",
		"..",
		"/",
		"\\",
	]) {
		const saved = await savePersistentAgentPromptFileAttachment({ fileName, fileContentBase64: "eA==" });
		expect(saved.fileName).toBe(fileName);
		expect(relative(isolatedRuntimeHome.directoryPath, saved.filePath)).toMatch(
			/^persistent-agent-prompt-file-attachments\/[a-f0-9-]{36}(\.(txt|md)|\/a\.x{220})?$/u,
		);
		expect(await readFile(saved.filePath, "utf8")).toBe("x");
	}
});
