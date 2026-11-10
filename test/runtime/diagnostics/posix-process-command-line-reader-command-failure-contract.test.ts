import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProcessCommandLinesForProcessIds } from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";

const processInspectionCommandMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(processInspectionCommandMocks.execFile, {
		[promisify.custom]: processInspectionCommandMocks.execFilePromise,
	}),
}));

beforeEach(() => {
	processInspectionCommandMocks.execFilePromise.mockReset();
});

describe("进程命令行查询的失败处理契约", () => {
	it.each([
		{ description: "退出码 1", code: 1 },
		{ description: "退出码 77", code: 77 },
		{ description: "超时终止", code: null, signal: "SIGTERM", killed: true },
		{ description: "输出被截断", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
	])("$description 时默认保留部分诊断结果，严格模式传播原始失败", async (failure) => {
		const error = Object.assign(new Error(failure.description), failure, {
			stdout: "  4120 /isolated/native-process --marker=fixture\n",
			stderr: "隔离进程查询失败",
		});
		processInspectionCommandMocks.execFilePromise.mockRejectedValue(error);

		await expect(readProcessCommandLinesForProcessIds([4120, 4121])).resolves.toEqual(
			new Map([[4120, "/isolated/native-process --marker=fixture"]]),
		);
		await expect(
			readProcessCommandLinesForProcessIds([4120, 4121], { requireSuccessfulCommandExecution: true }),
		).rejects.toBe(error);
	});

	it("严格模式在命令成功时返回正常进程结果", async () => {
		processInspectionCommandMocks.execFilePromise.mockResolvedValue({
			stdout: "  4120 /isolated/native-process\n",
			stderr: "",
		});
		await expect(
			readProcessCommandLinesForProcessIds([4120], { requireSuccessfulCommandExecution: true }),
		).resolves.toEqual(new Map([[4120, "/isolated/native-process"]]));
	});

	it("严格模式后续批次失败时不返回前一批的部分结果", async () => {
		const error = Object.assign(new Error("后续批次查询失败"), { code: 77, stdout: "", stderr: "" });
		processInspectionCommandMocks.execFilePromise
			.mockResolvedValueOnce({ stdout: "  1 /isolated/native-process\n", stderr: "" })
			.mockRejectedValueOnce(error);
		await expect(
			readProcessCommandLinesForProcessIds(
				Array.from({ length: 201 }, (_, index) => index + 1),
				{
					requireSuccessfulCommandExecution: true,
				},
			),
		).rejects.toBe(error);
		expect(processInspectionCommandMocks.execFilePromise).toHaveBeenCalledTimes(2);
	});
});
