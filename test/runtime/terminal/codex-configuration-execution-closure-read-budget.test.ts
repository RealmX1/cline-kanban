import * as fileSystemPromises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureCodexConfigurationExecutionClosure,
	verifyCodexConfigurationExecutionClosure,
} from "../../../src/codex-configuration-sync/codex-configuration-execution-closure";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:fs/promises", async (importOriginal) => {
	const originalFileSystem = await importOriginal<typeof fileSystemPromises>();
	return {
		...originalFileSystem,
		open: vi.fn(originalFileSystem.open),
		readFile: vi.fn(originalFileSystem.readFile),
	};
});

const originalFileSystem = await vi.importActual<typeof fileSystemPromises>("node:fs/promises");
const executionClosureByteBudget = 64 * 1024 * 1024;
let fixture: ReturnType<typeof createTempDir>;
let skillDirectoryPath: string;
let skillFilePath: string;

beforeEach(async () => {
	fixture = createTempDir("codex-execution-closure-read-budget-");
	fixture.path = await fileSystemPromises.realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	skillDirectoryPath = join(fixture.path, "skill-source");
	skillFilePath = join(skillDirectoryPath, "SKILL.md");
	await fileSystemPromises.mkdir(skillDirectoryPath);
	await fileSystemPromises.writeFile(skillFilePath, "阶段指引");
});

afterEach(() => {
	vi.mocked(fileSystemPromises.open).mockReset();
	vi.mocked(fileSystemPromises.readFile).mockReset();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

async function observeFileReadsAndMutateAfterFirstRead(filePath: string, mutateAfterFirstRead: () => Promise<void>) {
	const requestedReadEndOffsets: number[] = [];
	const actualReadByteLengths: number[] = [];
	const readBufferByteLengths: number[] = [];
	let sourceHandleClosed = false;
	vi.mocked(fileSystemPromises.open).mockImplementation(async (...parameters) => {
		const fileHandle = await originalFileSystem.open(...parameters);
		if (parameters[0] !== filePath) return fileHandle;
		fileHandle.read = new Proxy(fileHandle.read, {
			async apply(read, _receiver, parameters) {
				const [buffer, , requestedByteLength, position] = parameters as [Buffer, number, number, number];
				requestedReadEndOffsets.push(position + requestedByteLength);
				readBufferByteLengths.push(buffer.byteLength);
				const result = (await Reflect.apply(
					read,
					fileHandle,
					parameters,
				)) as fileSystemPromises.FileReadResult<Buffer>;
				actualReadByteLengths.push(result.bytesRead);
				if (actualReadByteLengths.length === 1) await mutateAfterFirstRead();
				return result;
			},
		});
		fileHandle.close = new Proxy(fileHandle.close, {
			async apply(close, _receiver, parameters) {
				const result: unknown = await Reflect.apply(close, fileHandle, parameters);
				sourceHandleClosed = true;
				return result;
			},
		});
		return fileHandle;
	});
	return {
		requestedReadEndOffsets,
		actualReadByteLengths,
		readBufferByteLengths,
		isSourceHandleClosed: () => sourceHandleClosed,
	};
}

describe("Codex 执行闭包读取预算", () => {
	it("文件大小超预算时，在打开或整体读取文件前拒绝", async () => {
		const helperFilePath = join(skillDirectoryPath, "000-oversized-helper");
		await fileSystemPromises.writeFile(helperFilePath, "");
		await fileSystemPromises.truncate(helperFilePath, executionClosureByteBudget + 1);
		vi.mocked(fileSystemPromises.readFile).mockRejectedValue(new Error("不应尝试整体读取超预算文件"));

		await expect(captureCodexConfigurationExecutionClosure(skillFilePath)).rejects.toThrow("有界采集预算");
		expect(fileSystemPromises.open).not.toHaveBeenCalled();
		expect(fileSystemPromises.readFile).not.toHaveBeenCalled();
	});

	it("先前文件耗尽总预算后，不再打开或整体读取后续文件", async () => {
		const helperFilePath = join(skillDirectoryPath, "000-fills-byte-budget-helper");
		await fileSystemPromises.writeFile(helperFilePath, "");
		await fileSystemPromises.truncate(helperFilePath, executionClosureByteBudget);

		await expect(captureCodexConfigurationExecutionClosure(skillFilePath)).rejects.toThrow("有界采集预算");
		expect(fileSystemPromises.open).not.toHaveBeenCalledWith(skillFilePath, expect.anything());
		expect(fileSystemPromises.readFile).not.toHaveBeenCalledWith(skillFilePath);
	});

	it("文件在读取期间增长时，只读取已观察大小和一个探测字节后拒绝并关闭句柄", async () => {
		const helperFilePath = join(skillDirectoryPath, "000-growing-helper");
		const initialHelperBytes = Buffer.from("helper");
		await fileSystemPromises.writeFile(helperFilePath, initialHelperBytes);
		const observation = await observeFileReadsAndMutateAfterFirstRead(helperFilePath, () =>
			fileSystemPromises.truncate(helperFilePath, executionClosureByteBudget + 1),
		);

		await expect(captureCodexConfigurationExecutionClosure(skillFilePath)).rejects.toThrow("采集时发生变化");
		expect(observation.actualReadByteLengths.length).toBeGreaterThan(0);
		expect(observation.actualReadByteLengths.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(
			initialHelperBytes.length + 1,
		);
		expect(Math.max(...observation.requestedReadEndOffsets)).toBeLessThanOrEqual(initialHelperBytes.length + 1);
		expect(Math.max(...observation.readBufferByteLengths)).toBeLessThanOrEqual(initialHelperBytes.length);
		expect(observation.isSourceHandleClosed()).toBe(true);
	});

	it("文件等长修改仍由采集前后的文件状态校验拒绝", async () => {
		const helperFilePath = join(skillDirectoryPath, "000-changing-helper");
		await fileSystemPromises.writeFile(helperFilePath, "before");
		const before = await fileSystemPromises.lstat(helperFilePath);
		await observeFileReadsAndMutateAfterFirstRead(helperFilePath, async () => {
			await fileSystemPromises.writeFile(helperFilePath, "after!");
			await fileSystemPromises.utimes(helperFilePath, before.atime, new Date(before.mtimeMs + 1_000));
		});

		await expect(captureCodexConfigurationExecutionClosure(skillFilePath)).rejects.toThrow("采集时发生变化");
	});

	it("保留循环软链拒绝和已保存闭包的内容摘要门禁", async () => {
		const closure = await captureCodexConfigurationExecutionClosure(skillFilePath);
		expect(await verifyCodexConfigurationExecutionClosure(closure)).toBe(closure.skillFilePath);
		await fileSystemPromises.writeFile(closure.skillFilePath, "已篡改正文");
		await expect(verifyCodexConfigurationExecutionClosure(closure)).rejects.toThrow("摘要不符");
		await fileSystemPromises.symlink(skillDirectoryPath, join(skillDirectoryPath, "recursive-directory"), "dir");
		await expect(captureCodexConfigurationExecutionClosure(skillFilePath)).rejects.toThrow("循环软链");
	});
});
