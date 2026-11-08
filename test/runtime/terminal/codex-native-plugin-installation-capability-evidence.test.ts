import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prepareCodexNativePluginInstallationCapabilityEvidence,
	recoverPendingCodexNativePluginInstallationCapabilityEvidence,
} from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-evidence";
import * as nativeVerification from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-verification";
import * as processCommandObservation from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let binary: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
	fixture = createTempDir("codex-plugin-capability-evidence-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	binary = join(fixture.path, "codex-capability-fixture");
	await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write('codex-cli 9.999.0');\n`, { mode: 0o700 });
	environment = { PATH: process.env.PATH, HOME: fixture.path };
	vi.spyOn(nativeVerification, "verifyCodexNativeSharedPluginInstallationCapability").mockResolvedValue({
		status: "supported",
		reason: "隔离行为通过",
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("Codex 插件安装能力按实际程序核验", () => {
	it("未来版本默认核验；并发和后续调用共用持久结果，不再运行子核验", async () => {
		const inputs = { binary, environment, workingDirectory: fixture.path };
		const [first, second] = await Promise.all([
			prepareCodexNativePluginInstallationCapabilityEvidence(inputs),
			prepareCodexNativePluginInstallationCapabilityEvidence(inputs),
		]);
		expect(first.status).toBe("supported");
		expect(first.nativeBinaryVersion).toBe("codex-cli 9.999.0");
		expect(second).toEqual(first);
		expect(await prepareCodexNativePluginInstallationCapabilityEvidence(inputs)).toEqual(first);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
	});
	it("版本查询失败仍按真实能力核验，不能用未知版本否定能力", async () => {
		await writeFile(binary, `#!${process.execPath}\nprocess.exitCode=1;\n`);
		const result = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		expect(result).toMatchObject({ status: "supported", nativeBinaryVersion: null });
	});
	it("确证不兼容才记为不支持，并保留原因", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockResolvedValue({
			status: "unsupported",
			reason: "原生程序缺少 marketplace upgrade 命令",
		});
		const result = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		expect(result).toMatchObject({ status: "unsupported", reason: expect.stringContaining("缺少") });
	});
	it("临时失败每三次进入持久冷却，同一程序恢复后自动开启新窗口", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValue(
			new Error("隔离核验超时"),
		);
		const inputs = { binary, environment };
		let result = await prepareCodexNativePluginInstallationCapabilityEvidence(inputs);
		expect(result).toMatchObject({ status: "retry_pending", attemptCount: 1 });
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
		for (let attempt = 2; attempt <= 3; attempt++) {
			vi.spyOn(Date, "now").mockReturnValue(result.nextAttemptAtMs + 1);
			await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
			result = await prepareCodexNativePluginInstallationCapabilityEvidence(inputs);
			expect(result).toMatchObject({ status: "retry_pending", attemptCount: attempt });
		}
		expect(result.nextAttemptAtMs - result.observedAtMs).toBe(15 * 60_000);
		vi.spyOn(Date, "now").mockReturnValue(result.nextAttemptAtMs - 1);
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(3);
		const failedAttemptOriginal = await readFile(
			join(result.isolatedProbeDirectoryPath ?? "", "verification-result.json"),
			"utf8",
		);
		vi.spyOn(Date, "now").mockReturnValue(result.nextAttemptAtMs + 1);
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockResolvedValue({
			status: "supported",
			reason: "同一程序的临时资源压力已经解除",
		});
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
		expect(await prepareCodexNativePluginInstallationCapabilityEvidence(inputs)).toMatchObject({
			status: "supported",
			attemptCount: 4,
			evidencePath: result.evidencePath,
			nativeExecutableIdentityDigest: result.nativeExecutableIdentityDigest,
		});
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(4);
		expect(await readFile(join(result.isolatedProbeDirectoryPath ?? "", "verification-result.json"), "utf8")).toBe(
			failedAttemptOriginal,
		);
	});
	it("程序文件替换使成功缓存失效，重新核验；磁盘证据可独立读取", async () => {
		const first = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write('codex-cli 10.1.0');\n`);
		const next = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		expect(next.nativeExecutableIdentityDigest).not.toBe(first.nativeExecutableIdentityDigest);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(2);
		expect(JSON.parse(await readFile(next.evidencePath, "utf8"))).toMatchObject({ status: "supported" });
	});
	it("另一独立进程复用持久成功证据，无需再次运行版本查询或原生探测", async () => {
		const first = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		const moduleUrl = new URL(
			"../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-evidence.ts",
			import.meta.url,
		).href;
		const source = `import { prepareCodexNativePluginInstallationCapabilityEvidence } from ${JSON.stringify(moduleUrl)};const result=await prepareCodexNativePluginInstallationCapabilityEvidence({binary:${JSON.stringify(binary)},environment:${JSON.stringify(environment)}});process.stdout.write(JSON.stringify(result));`;
		const result = await promisify(execFile)(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", source],
			{ env: environment, timeout: 15_000, maxBuffer: 32_768 },
		);
		expect(JSON.parse(result.stdout)).toEqual(first);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
	});
	it("中断后的原生写入者仍存活时只等待，退出后自动恢复且不重复探测", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
			new Error("原控制器中断"),
		);
		const interrupted = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		const commandMarker = join(interrupted.isolatedProbeDirectoryPath ?? "", "native-command-1");
		await writeFile(
			interrupted.evidencePath,
			JSON.stringify({
				...interrupted,
				status: "running",
				nextAttemptAtMs: 0,
				activeNativeProcess: { processId: 12345, commandMarker },
			}),
		);
		const processExistence = vi.spyOn(process, "kill").mockReturnValue(true);
		const commands = vi
			.spyOn(processCommandObservation, "readProcessCommandLinesForProcessIds")
			.mockResolvedValue(new Map([[12345, `codex -c log_dir=${commandMarker}`]]));
		const waiting = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		expect(waiting).toMatchObject({
			status: "retry_pending",
			attemptCount: 1,
			reason: expect.stringContaining("尚未退出"),
		});
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
		commands.mockResolvedValue(new Map());
		processExistence.mockImplementation(() => {
			throw Object.assign(new Error("进程已退出"), { code: "ESRCH" });
		});
		vi.spyOn(Date, "now").mockReturnValue(waiting.nextAttemptAtMs + 1);
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
		expect(await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment })).toMatchObject({
			status: "supported",
			attemptCount: 2,
		});
	});
	it.each(["empty", "failed", "permission_denied"])(
		"进程查询 %s 时保留原身份，只有确证退出才继续",
		async (observation) => {
			vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
				new Error("控制器中断"),
			);
			const interrupted = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
			const activeNativeProcess = {
				processId: 12345,
				commandMarker: join(interrupted.isolatedProbeDirectoryPath ?? "", "native-command-1"),
			};
			await writeFile(
				interrupted.evidencePath,
				JSON.stringify({ ...interrupted, status: "running", nextAttemptAtMs: 0, activeNativeProcess }),
			);
			const processExistence = vi.spyOn(process, "kill").mockImplementation(() => {
				if (observation === "permission_denied") throw Object.assign(new Error("不能查询进程"), { code: "EPERM" });
				return true;
			});
			const commands = vi.spyOn(processCommandObservation, "readProcessCommandLinesForProcessIds");
			if (observation === "empty") commands.mockResolvedValue(new Map());
			else commands.mockRejectedValue(new Error("ps 查询失败或输出超限"));
			const waiting = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
			expect(waiting).toMatchObject({
				status: "retry_pending",
				attemptCount: 1,
				activeNativeProcess,
				isolatedProbeDirectoryPath: interrupted.isolatedProbeDirectoryPath,
			});
			expect(JSON.parse(await readFile(waiting.evidencePath, "utf8"))).toMatchObject({ activeNativeProcess });
			expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
			vi.spyOn(Date, "now").mockReturnValue(waiting.nextAttemptAtMs + 1);
			await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
			expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
			processExistence.mockImplementation(() => {
				throw Object.assign(new Error("进程已退出"), { code: "ESRCH" });
			});
			vi.spyOn(Date, "now").mockReturnValue(waiting.nextAttemptAtMs + 30_001);
			await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
			expect(JSON.parse(await readFile(waiting.evidencePath, "utf8"))).toMatchObject({
				status: "supported",
				attemptCount: 2,
				activeNativeProcess: null,
			});
		},
	);
	it.each(["query_failed", "missing_command"])(
		"PID 回执尚未持久化且观测 %s 时保留运行记录并在补证后恢复",
		async (observation) => {
			vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
				new Error("控制器中断"),
			);
			const interrupted = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
			await writeFile(
				interrupted.evidencePath,
				JSON.stringify({ ...interrupted, status: "running", nextAttemptAtMs: 0 }),
			);
			vi.spyOn(processCommandObservation, "readPosixProcessResourceTable").mockResolvedValue(
				processCommandObservation.parsePosixProcessResourceTableText(
					`${process.pid} 1 1 100 0:00.01 Wed Sep 30 00:40:58 2026 S`,
				),
			);
			vi.spyOn(process, "kill").mockReturnValue(true);
			const commands = vi.spyOn(processCommandObservation, "readProcessCommandLinesForProcessIds");
			if (observation === "query_failed") commands.mockRejectedValue(new Error("ps 输出预算超限"));
			else commands.mockResolvedValue(new Map());
			const waiting = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
			expect(waiting).toMatchObject({
				status: "running",
				attemptCount: 1,
				activeNativeProcess: null,
				isolatedProbeDirectoryPath: interrupted.isolatedProbeDirectoryPath,
			});
			expect(commands).toHaveBeenCalledWith([process.pid], { requireSuccessfulCommandExecution: true });
			expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenCalledTimes(1);
			commands.mockResolvedValue(new Map([[process.pid, "node capability-controller"]]));
			vi.spyOn(Date, "now").mockReturnValue(waiting.nextAttemptAtMs + 1);
			await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
			expect(JSON.parse(await readFile(waiting.evidencePath, "utf8"))).toMatchObject({
				status: "supported",
				attemptCount: 2,
			});
		},
	);
	it("补扫沿用原 PATH 与工作目录，在同一个证据桶推进重试", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
			new Error("暂时缺证"),
		);
		const initialEnvironment = { ...environment, PATH: "/usr/bin:/bin" };
		const pending = await prepareCodexNativePluginInstallationCapabilityEvidence({
			binary,
			environment: initialEnvironment,
			workingDirectory: fixture.path,
		});
		vi.spyOn(Date, "now").mockReturnValue(pending.nextAttemptAtMs + 1);
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence({ ...environment, PATH: "/bin:/usr/bin" });
		expect(JSON.parse(await readFile(pending.evidencePath, "utf8"))).toMatchObject({
			status: "supported",
			attemptCount: 2,
			executableSearchPath: initialEnvironment.PATH,
			verificationWorkingDirectoryPath: fixture.path,
		});
		expect(await readdir(dirname(dirname(pending.evidencePath)))).toHaveLength(1);
		expect(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).toHaveBeenLastCalledWith(
			expect.objectContaining({ environment: expect.objectContaining({ PATH: initialEnvironment.PATH }) }),
		);
	});
	it("旧记录缺少 PATH 时不按错误环境另起证据桶，原环境恢复后继续补证", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
			new Error("暂时缺证"),
		);
		const initialEnvironment = { ...environment, PATH: "/usr/bin:/bin" };
		const pending = await prepareCodexNativePluginInstallationCapabilityEvidence({
			binary,
			environment: initialEnvironment,
		});
		const { executableSearchPath: _path, verificationWorkingDirectoryPath: _cwd, ...legacy } = pending;
		await writeFile(pending.evidencePath, JSON.stringify(legacy));
		vi.spyOn(Date, "now").mockReturnValue(pending.nextAttemptAtMs + 1);
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence({ ...environment, PATH: "/bin:/usr/bin" });
		expect(await readdir(dirname(dirname(pending.evidencePath)))).toHaveLength(1);
		expect(JSON.parse(await readFile(pending.evidencePath, "utf8"))).toMatchObject({
			status: "retry_pending",
			attemptCount: 1,
		});
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(initialEnvironment);
		expect(JSON.parse(await readFile(pending.evidencePath, "utf8"))).toMatchObject({
			status: "supported",
			attemptCount: 2,
			executableSearchPath: initialEnvironment.PATH,
		});
	});

	it("一份损坏的历史记录不阻止其他能力的自动补证", async () => {
		vi.mocked(nativeVerification.verifyCodexNativeSharedPluginInstallationCapability).mockRejectedValueOnce(
			new Error("瞬时缺证"),
		);
		const pending = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		const malformedDirectory = join(
			fixture.path,
			".cline",
			"kanban",
			"codex-native-plugin-installation-capability-evidence",
			"0".repeat(64),
		);
		await mkdir(malformedDirectory);
		await writeFile(join(malformedDirectory, "capability-evidence.json"), "损坏的旧原件");
		vi.spyOn(Date, "now").mockReturnValue(pending.nextAttemptAtMs + 1);
		await recoverPendingCodexNativePluginInstallationCapabilityEvidence(environment);
		expect(await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment })).toMatchObject({
			status: "supported",
			attemptCount: 2,
		});
		expect(await readFile(join(malformedDirectory, "capability-evidence.json"), "utf8")).toBe("损坏的旧原件");
	});
	it("证据目录被软链替换时拒绝，不把归属异常当作不兼容", async () => {
		const evidenceRoot = join(
			fixture.path,
			".cline",
			"kanban",
			"codex-native-plugin-installation-capability-evidence",
		);
		await mkdir(evidenceRoot, { recursive: true });
		await rename(evidenceRoot, `${evidenceRoot}-original`);
		await symlink(`${evidenceRoot}-original`, evidenceRoot, "junction");
		await expect(prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment })).rejects.toThrow(
			/归属/,
		);
	});
	it("HOME 的合法软链不改变物理证据归属，也不影响未来版本默认核验", async () => {
		const linkedUserHome = join(fixture.path, "logical-user-home");
		await symlink(fixture.path, linkedUserHome, "junction");
		vi.stubEnv("HOME", linkedUserHome);
		const result = await prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		expect(result.status).toBe("supported");
		expect(result.evidencePath.startsWith(join(fixture.path, ".cline"))).toBe(true);
	});
	it("核验开始时冻结 runtime HOME，异步等待期间环境变化不改写归属", async () => {
		const capability = prepareCodexNativePluginInstallationCapabilityEvidence({ binary, environment });
		const anotherHome = join(fixture.path, "another-runtime-user-home");
		await mkdir(anotherHome);
		vi.stubEnv("HOME", anotherHome);
		const result = await capability;
		expect(result.evidencePath.startsWith(join(fixture.path, ".cline"))).toBe(true);
	});
});

import { execFile } from "node:child_process";
