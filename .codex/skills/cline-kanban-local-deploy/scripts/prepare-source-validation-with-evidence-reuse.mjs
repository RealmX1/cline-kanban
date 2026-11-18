#!/usr/bin/env node
// 源码验证只复用已证明的覆盖；本次产物、ABI 和运行实例仍由部署流程核验。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, uptime } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const REPORT_FILENAME = "source-validation-evidence-reuse-report.json";
const MAXIMUM_METADATA_BYTES = 4 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_DISCOVERY_DIRECTORIES = 16_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sourceValidationPreparerContents = await readFile(new URL(import.meta.url));
const evidenceVerificationStatistics = {
	discoveryDirectoriesRead: 0,
	metadataFilesRead: 0,
	hashedFiles: 0,
	evidenceBytesHashed: 0,
};
const hashedFiles = new Map();
const evidenceSnapshots = new Map();
const evidenceDiscoveryIssues = [];
let sourceValidationOutputDirectory;
let readOnlyRecoveryObservation = false;
let stopped = false;
let activeChild;

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (readOnlyRecoveryObservation) process.exit(signal === "SIGTERM" ? 143 : 130);
		stopped = true;
		if (activeChild?.pid) {
			try {
				const supervising = process.argv[2] === "--supervise-source-validation-check";
				process.kill(supervising ? -process.pid : -activeChild.pid, supervising ? "SIGKILL" : signal);
			} catch {
				/* 子进程可能已自然结束。 */
			}
		}
	});
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function isSourceValidationInterruptedExitCode(exitCode) {
	return [130, -2].includes(exitCode);
}
function isPathInsideDirectory(root, path) {
	const suffix = relative(root, path);
	return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
function assert(condition, message) {
	if (!condition) throw new Error(message);
}
function stringArray(value) {
	return (
		Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
	);
}

async function readBoundedJsonEvidenceFile(path) {
	const stat = await lstat(path);
	assert(stat.isFile() && stat.size <= MAXIMUM_METADATA_BYTES, `记录不是普通文件或超过读取预算：${path}`);
	evidenceVerificationStatistics.metadataFilesRead++;
	return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJsonEvidenceFile(path) {
	try {
		return await readBoundedJsonEvidenceFile(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function resolveProspectiveDirectoryRealpath(path) {
	let ancestor = resolve(path);
	const missingSegments = [];
	for (;;) {
		try {
			return join(await realpath(ancestor), ...missingSegments);
		} catch (error) {
			if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
			missingSegments.unshift(basename(ancestor));
			ancestor = dirname(ancestor);
		}
	}
}

async function writeJsonFileDurablyWhenChanged(path, value) {
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	try {
		if ((await readFile(path, "utf8")) === serialized) return;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.writing`;
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(serialized);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporaryPath, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function computeEvidenceFileSha256Once(path) {
	const resolved = await realpath(path);
	if (hashedFiles.has(resolved)) return hashedFiles.get(resolved);
	const stat = await lstat(path);
	assert(stat.isFile(), `证据必须是普通文件：${path}`);
	assert(
		evidenceVerificationStatistics.evidenceBytesHashed + stat.size <= MAXIMUM_EVIDENCE_BYTES,
		"证据摘要预算已用完，保留待补证状态",
	);
	evidenceVerificationStatistics.evidenceBytesHashed += stat.size;
	evidenceVerificationStatistics.hashedFiles++;
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	const value = digest.digest("hex");
	hashedFiles.set(resolved, value);
	return value;
}

function runReadOnlyGitCommand(sourceCheckoutPath, arguments_) {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-C", sourceCheckoutPath, ...arguments_],
		{
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		},
	);
	assert(result.status === 0, `只读 Git 查询失败：${result.stderr || result.error || arguments_[0]}`);
	return result.stdout;
}

async function captureVerifiedCandidateSourceSnapshot(sourceCheckoutPath, commit) {
	assert(
		!runReadOnlyGitCommand(sourceCheckoutPath, ["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
		"候选工作目录包含 WIP；请使用固定提交的隔离候选，不改动原 WIP",
	);
	const treeOid = runReadOnlyGitCommand(sourceCheckoutPath, ["rev-parse", `${commit}^{tree}`]).trim();
	assert(
		runReadOnlyGitCommand(sourceCheckoutPath, ["rev-parse", "HEAD^{tree}"]).trim() === treeOid,
		"候选工作目录与固定提交树不同",
	);
	const entries = runReadOnlyGitCommand(sourceCheckoutPath, ["ls-tree", "-r", "-z", "--full-tree", commit])
		.split("\0")
		.filter(Boolean)
		.sort((left, right) =>
			Buffer.compare(
				Buffer.from(left.slice(left.indexOf("\t") + 1)),
				Buffer.from(right.slice(right.indexOf("\t") + 1)),
			),
		);
	const manifest = createHash("sha256");
	function encodeLength(length) {
		const buffer = Buffer.alloc(8);
		buffer.writeBigUInt64BE(BigInt(length));
		return buffer;
	}
	for (const entry of entries) {
		const [header, ...pathSegments] = entry.split("\t");
		const [mode, type, objectId] = header.split(" ");
		const path = join(sourceCheckoutPath, pathSegments.join("\t"));
		assert(type === "blob", "候选包含无法自动核对的 submodule，保留待补证状态");
		const stat = await lstat(path);
		assert(
			(mode === "120000" && stat.isSymbolicLink()) || (mode !== "120000" && stat.isFile()),
			`候选文件类型改变：${path}`,
		);
		const contents = mode === "120000" ? Buffer.from(await readlink(path)) : await readFile(path);
		const encodedPath = Buffer.from(pathSegments.join("\t"));
		manifest.update("P").update(encodeLength(encodedPath.length)).update(encodedPath);
		if (mode === "120000") manifest.update("L");
		else manifest.update("F").update(stat.mode & 0o111 ? "X" : "-");
		manifest.update(encodeLength(contents.length)).update(contents);
		const observedId = createHash(objectId.length === 40 ? "sha1" : "sha256")
			.update(`blob ${contents.length}\0`)
			.update(contents)
			.digest("hex");
		assert(
			observedId === objectId && (mode === "120000" || Boolean(stat.mode & 0o111) === (mode === "100755")),
			`候选文件内容或权限改变：${path}`,
		);
	}
	return { treeOid, contentManifestSha256: manifest.digest("hex") };
}

async function listEvidenceSubdirectoryNamesWithinBudget(path) {
	try {
		assert(
			evidenceVerificationStatistics.discoveryDirectoriesRead < MAXIMUM_DISCOVERY_DIRECTORIES,
			"证据目录发现预算已用完",
		);
		evidenceVerificationStatistics.discoveryDirectoriesRead++;
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

// Python 原生产方的指纹使用 ensure_ascii 与默认分隔符；不能换成另一种 JSON 序列化后声称相等。
function serializePythonCompatibleCommandFingerprintJson(value) {
	if (Array.isArray(value)) return `[${value.map(serializePythonCompatibleCommandFingerprintJson).join(", ")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${serializePythonCompatibleCommandFingerprintJson(key)}: ${serializePythonCompatibleCommandFingerprintJson(value[key])}`,
			)
			.join(", ")}}`;
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function createSourceValidationCommandIdentityKey(argv, sourceCheckoutPath) {
	assert(stringArray(argv), "命令必须是非空 argv 数组");
	const command = [...argv];
	const validationEnvironmentIdentity = [];
	if (basename(command[0]) === "env") {
		command.shift();
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[0] || "")) {
			const assignment = command.shift();
			validationEnvironmentIdentity.push(assignment);
		}
	}
	if (basename(command[0] || "") === "npm") command[0] = "npm";
	return JSON.stringify([
		validationEnvironmentIdentity.sort(),
		command.map((argument) =>
			isAbsolute(argument) && isPathInsideDirectory(sourceCheckoutPath, argument)
				? `<source>/${relative(sourceCheckoutPath, argument)}`
				: argument,
		),
	]);
}

async function computeLegacyPythonContentManifestSha256(sourceCheckoutPath) {
	const entries = [];
	for (const path of runReadOnlyGitCommand(sourceCheckoutPath, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
		const absolutePath = join(sourceCheckoutPath, path);
		const stat = await lstat(absolutePath);
		const contents = stat.isSymbolicLink() ? Buffer.from(await readlink(absolutePath)) : await readFile(absolutePath);
		entries.push([path, sha256(contents), stat.mode]);
	}
	return sha256(serializePythonCompatibleCommandFingerprintJson(entries));
}

async function computeSourceValidationCommandEnvironmentFingerprint(argv, cwd) {
	const scripts = {};
	for (const argument of argv.slice(1)) {
		if (/\.(?:py|sh|bash|js|mjs|cjs)$/.test(argument)) {
			const script = resolve(cwd, argument);
			try {
				scripts[script] = await computeEvidenceFileSha256Once(script);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	let executable = null;
	try {
		executable = isAbsolute(argv[0])
			? await realpath(argv[0])
			: await realpath(
					spawnSync("which", [argv[0]], {
						encoding: "utf8",
						env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}` },
					}).stdout.trim(),
				);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return sha256(
		serializePythonCompatibleCommandFingerprintJson({
			argv,
			executable,
			executableSha256: executable ? await computeEvidenceFileSha256Once(executable) : null,
			scriptSha256: scripts,
		}),
	);
}

function currentSourceValidationProcessEnvironment() {
	return Object.fromEntries(
		Object.entries({ ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}` }).filter(
			([key]) =>
				!key.startsWith("GIT_") &&
				!key.startsWith("BASE_BRANCH_SYNC_") &&
				!key.startsWith("RVF_INDEPENDENT_") &&
				!["_", "SHLVL", "PWD", "OLDPWD", "__PYVENV_LAUNCHER__"].includes(key),
		),
	);
}

function probePythonRuntimeIdentity(executable) {
	const result = spawnSync(
		executable,
		[
			"-c",
			"import json,pathlib,platform,sys;print(json.dumps({'pythonExecutable':str(pathlib.Path(sys.executable).resolve()),'pythonVersion':sys.version,'platform':platform.platform()}))",
		],
		{ encoding: "utf8", env: currentSourceValidationProcessEnvironment(), timeout: 10_000 },
	);
	if (result.status !== 0) return null;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return null;
	}
}

async function currentBaseBranchSyncPythonIdentities() {
	const identities = [];
	const executables = new Set();
	for (const name of ["python3", "python"]) {
		const result = spawnSync("which", [name], {
			encoding: "utf8",
			env: currentSourceValidationProcessEnvironment(),
		});
		if (result.status !== 0 || !result.stdout.trim()) continue;
		try {
			executables.add(await realpath(result.stdout.trim()));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	for (const executable of executables) {
		const identity = probePythonRuntimeIdentity(executable);
		if (identity?.pythonExecutable && identity.pythonVersion) identities.push(identity);
	}
	return identities;
}

async function isStandardRecordEnvironmentCompatible(record, state, current) {
	const preflight = state.environmentPreflight;
	if (!preflight || !["READY", "NOT_APPLICABLE"].includes(preflight.status)) return false;
	const nodeIdentity = {
		runtime: preflight.runtime,
		requirement: preflight.runtimeRequirement?.[0],
		dependencies: preflight.dependencies,
		nativeModules: (preflight.nativeModules || []).map(({ name, loaded }) => ({ name, loaded })),
	};
	if (sha256(serializePythonCompatibleCommandFingerprintJson(nodeIdentity)) !== preflight.environmentFingerprintSha256)
		return false;
	const environment = currentSourceValidationProcessEnvironment();
	const currentFingerprints = (await currentBaseBranchSyncPythonIdentities()).map((python) =>
		sha256(
			serializePythonCompatibleCommandFingerprintJson({
				node: preflight.environmentFingerprintSha256,
				pythonExecutable: python.pythonExecutable,
				pythonVersion: python.pythonVersion,
				environment,
			}),
		),
	);
	if (!currentFingerprints.includes(record.environmentFingerprintSha256)) return false;
	if (preflight.status === "NOT_APPLICABLE") return Object.keys(current.lockfiles).length === 0;
	if (
		!preflight.runtime?.executable ||
		(await realpath(preflight.runtime.executable)) !== current.nodeExecutable ||
		preflight.runtime.version !== current.nodeVersion ||
		preflight.runtime.modulesAbi !== current.nodeModulesAbi ||
		!preflight.nativeModules?.every((module) => module.loaded)
	)
		return false;
	return (
		preflight.dependencies?.lockfileSha256 === current.lockfiles["."] &&
		(preflight.dependencies?.installedLockfileSha256 || null) === (current.installedDependencyMetadata["."] || null)
	);
}

function isExplicitRecordEnvironmentCompatible(historical, current) {
	if (!historical || typeof historical.environment !== "object" || !historical.environment) return false;
	const { environment: historicalEnvironment, ...historicalIdentity } = historical;
	const { processEnvironmentSha256, ...currentIdentity } = current;
	return (
		sha256(serializePythonCompatibleCommandFingerprintJson(historicalEnvironment)) === processEnvironmentSha256 &&
		serializePythonCompatibleCommandFingerprintJson(historicalIdentity) ===
			serializePythonCompatibleCommandFingerprintJson(currentIdentity)
	);
}

function isRvfNativeRecordEnvironmentCompatible(validation) {
	const runtime = validation.runtime_environment;
	if (
		!runtime ||
		typeof runtime.python_executable !== "string" ||
		typeof runtime.python !== "string" ||
		typeof runtime.platform !== "string" ||
		!SHA256_PATTERN.test(runtime.environment_sha256)
	)
		return false;
	if (
		sha256(serializePythonCompatibleCommandFingerprintJson({ ...process.env })) !== runtime.environment_sha256
	)
		return false;
	const currentPython = probePythonRuntimeIdentity(runtime.python_executable);
	return (
		currentPython?.pythonExecutable === runtime.python_executable &&
		currentPython.pythonVersion === runtime.python &&
		currentPython.platform === runtime.platform
	);
}

function sourceValidationConclusionTime(check) {
	const value = check.concludedAt || check.startedAt;
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(time) ? time : null;
}

function selectLatestSourceValidationConclusion(matches) {
	const conclusions = matches.filter((candidate) => ["passed", "failed"].includes(candidate.status));
	let latest = conclusions[0];
	for (const candidate of conclusions.slice(1)) {
		const candidateTime = sourceValidationConclusionTime(candidate);
		const latestTime = sourceValidationConclusionTime(latest);
		if (candidateTime !== null && latestTime !== null && candidateTime !== latestTime) {
			if (candidateTime > latestTime) latest = candidate;
		} else if (candidate.status === "failed") latest = candidate;
	}
	return latest;
}

async function verifyAndSnapshotEvidenceFile(path, expected, bundleDirectory, copyManifest = []) {
	assert(typeof path === "string" && isAbsolute(path) && SHA256_PATTERN.test(expected), "证据路径或摘要缺失");
	const copy = copyManifest.find((entry) => entry.sourcePath === path && entry.sha256 === expected);
	const candidates =
		copy && isPathInsideDirectory(bundleDirectory, resolve(copy.durableCopyPath))
			? [copy.durableCopyPath, path]
			: [path];
	let lastError;
	for (const candidate of candidates) {
		try {
			assert((await computeEvidenceFileSha256Once(candidate)) === expected, `证据摘要不匹配：${candidate}`);
			if (readOnlyRecoveryObservation) return candidate;
			const snapshotPath = join(sourceValidationOutputDirectory, "consumed-source-validation-evidence", expected);
			if (!evidenceSnapshots.has(expected)) {
				await mkdir(dirname(snapshotPath), { recursive: true });
				try {
					await copyFile(candidate, snapshotPath, 1);
				} catch (error) {
					if (error.code !== "EEXIST") throw error;
					const existingDigest = await computeEvidenceFileSha256Once(snapshotPath);
					if (existingDigest !== expected) {
						await rename(snapshotPath, `${snapshotPath}.rejected-${existingDigest}`);
						await copyFile(candidate, snapshotPath, 1);
						hashedFiles.delete(await realpath(snapshotPath));
						assert(
							(await computeEvidenceFileSha256Once(snapshotPath)) === expected,
							"从绑定原件恢复证据副本失败",
						);
					}
				}
				const snapshotFile = await open(snapshotPath, "r");
				await chmod(snapshotPath, 0o600);
				assert((await computeEvidenceFileSha256Once(snapshotPath)) === expected, "保存后的证据副本与原件摘要不同");
				try {
					await snapshotFile.sync();
				} finally {
					await snapshotFile.close();
				}
				const snapshotDirectory = await open(dirname(snapshotPath), "r");
				try {
					await snapshotDirectory.sync();
				} finally {
					await snapshotDirectory.close();
				}
				evidenceSnapshots.set(expected, { sourcePath: path, snapshotPath, sha256: expected });
			}
			return snapshotPath;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function parseStaticPythonStringArray(text) {
	const values = [];
	let remainder = text.trim();
	while (remainder.length) {
		const match = /^'((?:\\.|[^'\\])*)'\s*(?:,\s*|$)/.exec(remainder);
		assert(match && !/\\(?![\\'"nrt])/.test(match[1]), "旧 runner 包含不支持的动态参数，不能按阶段名推断覆盖");
		values.push(
			match[1].replace(/\\([\\'"nrt])/g, (_, escaped) => ({ n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped),
		);
		remainder = remainder.slice(match[0].length);
	}
	return values;
}

function extractStaticallyBoundLegacyNpmCommands(runner, phase) {
	assert(/^[a-z-]+$/.test(phase), "旧验证阶段名不合法");
	const block = new RegExp(`(?:if|elif) mode == '${phase}':([\\s\\S]*?)(?=\\nelif |\\nelse:|$)`).exec(runner)?.[1];
	assert(block, "旧 runner 没有可静态识别的阶段");
	if (/environment\[/.test(block)) return [];
	const calls = [...block.matchAll(/execute\(npm\+\[([^\]]*)\](\+files)?\)/g)];
	assert(calls.length > 0, "旧 runner 的实际命令无法静态还原");
	return calls.map((call) => [
		"npm",
		...parseStaticPythonStringArray(call[1]),
		...(call[2] ? parseStaticPythonStringArray(/files\s*=\s*\[([^\]]*)\]/.exec(block)?.[1] ?? "") : []),
	]);
}

async function discoverReusableSourceValidationChecks(
	sourceCheckoutPath,
	gitCommonDirectory,
	treeOid,
	contentManifestSha256,
	runtimeHomeDirectoryPath,
	currentEnvironment,
) {
	const sourceValidationCheckResults = [];
	let legacyPythonContentManifestSha256;
	const addIssue = (path, error) =>
		evidenceDiscoveryIssues.push({ evidencePath: path, reason: String(error.message || error) });
	const operationDirectories = [join(gitCommonDirectory, "base-branch-sync/durable-operations")];
	for (const name of await listEvidenceSubdirectoryNamesWithinBudget(join(gitCommonDirectory, "worktrees")))
		operationDirectories.push(join(gitCommonDirectory, "worktrees", name, "base-branch-sync/durable-operations"));
	for (const operations of operationDirectories) {
		for (const name of await listEvidenceSubdirectoryNamesWithinBudget(operations)) {
			const statePath = join(operations, name, "operation-state.json");
			try {
				const state = await readOptionalJsonEvidenceFile(statePath);
				if (!state || resolve(state.gitCommonDirectory || "/") !== gitCommonDirectory) continue;
				for (const reference of state.validationRecords || []) {
					try {
						assert(
							isPathInsideDirectory(join(operations, name), resolve(reference.path)),
							"验证原件越出所属 operation",
						);
						const record = await readBoundedJsonEvidenceFile(reference.path);
						if (record.treeOid !== treeOid) continue;
						assert(
							(await computeEvidenceFileSha256Once(reference.path)) === reference.sha256,
							"验证记录摘要不匹配",
						);
						assert(
							record.contentManifestSha256 === contentManifestSha256,
							"验证对应相同 HEAD 下的其他工作目录内容，不能仅凭 tree 复用",
						);
						assert(
							record.kind === "base-branch-sync-current-tree-validation" && record.schemaVersion === 1,
							"验证记录版本不支持",
						);
						assert(
							["taskId", "sessionId", "gitCommonDirectory", "worktree"].every(
								(key) => record[key] === state[key],
							) &&
								record.taskId &&
								record.sessionId,
							"验证归属不匹配",
						);
						assert(
							record.context === "task-tree" &&
								SHA256_PATTERN.test(record.contentManifestSha256) &&
								SHA256_PATTERN.test(record.environmentFingerprintSha256),
							"记录不属于源码树验证或缺少内容与环境身份",
						);
						assert(
							(await computeSourceValidationCommandEnvironmentFingerprint(record.argv, record.worktree)) ===
								record.commandEnvironmentFingerprintSha256,
							"命令或包装脚本指纹不匹配",
						);
						const proofFiles = [];
						for (const stream of ["stdout", "stderr"])
							proofFiles.push(
								await verifyAndSnapshotEvidenceFile(
									record[`${stream}Path`],
									record[`${stream}Sha256`],
									gitCommonDirectory,
								),
							);
						proofFiles.push(
							await verifyAndSnapshotEvidenceFile(reference.path, reference.sha256, gitCommonDirectory),
						);
						const commandRecord = await readOptionalJsonEvidenceFile(join(dirname(reference.path), "command.json"));
						if (commandRecord)
							assert(JSON.stringify(commandRecord.argv) === JSON.stringify(record.argv), "验证与执行原件命令不一致");
						const key = createSourceValidationCommandIdentityKey(record.argv, record.worktree);
						sourceValidationCheckResults.push({
							commandKeys: [key],
							argv: record.argv,
							coverage: record.coverage,
							taskId: record.taskId,
							evidencePath: reference.path,
							evidenceSha256: reference.sha256,
							proofFiles,
							environmentCompatible: await isStandardRecordEnvironmentCompatible(record, state, currentEnvironment),
							status: isSourceValidationInterruptedExitCode(record.exitCode)
								? "interrupted"
								: record.status === "passed" && record.exitCode === 0
									? "passed"
									: "failed",
							sourceFormat: record.kind,
							startedAt: record.startedAtUtc || record.startedAt || commandRecord?.startedAtUtc,
							concludedAt: record.finishedAtUtc || record.completedAtUtc || commandRecord?.finishedAtUtc,
						});
					} catch (error) {
						addIssue(reference.path, error);
					}
				}
			} catch (error) {
				addIssue(statePath, error);
			}
		}
	}
	async function discoverBundles(directory, remainingDepth) {
		const bundlePath = join(directory, "final-complete-tree-verification-evidence.json");
		try {
			const bundle = await readOptionalJsonEvidenceFile(bundlePath);
			if (bundle?.completeTree === treeOid) {
				assert(bundle.status === "passed", "备用证据包尚未通过最终验证");
				const receipt = await readBoundedJsonEvidenceFile(
					join(directory, "commit-and-base-branch-sync-result.json"),
				);
				assert(
					receipt.taskId === bundle.taskId &&
						receipt.taskHead === bundle.taskCommit &&
						receipt.completeTree === treeOid &&
						receipt.status === "LOCAL_COMMIT_AND_BASE_HANDBACK_COMPLETE",
					"备用证据包与落地回执不一致",
				);
				assert(
					resolve(
						receipt.baseWorktree,
						runReadOnlyGitCommand(receipt.baseWorktree, ["rev-parse", "--git-common-dir"]).trim(),
					) === gitCommonDirectory &&
						runReadOnlyGitCommand(sourceCheckoutPath, ["rev-parse", `${bundle.taskCommit}^{tree}`]).trim() ===
							treeOid,
					"备用证据包不属于本仓库与候选树",
				);
				const manifest = await readOptionalJsonEvidenceFile(join(directory, "validation-audit-copy-manifest.json"));
				const copies = manifest?.files || [];
				let precommitEnvironmentCompatible = false;
				for (const [phase, proof] of Object.entries(bundle.proofs || {})) {
					try {
						const recordPath = await verifyAndSnapshotEvidenceFile(
							proof.recordPath,
							proof.recordSha256,
							directory,
							copies,
						);
						const record = await readBoundedJsonEvidenceFile(recordPath);
						legacyPythonContentManifestSha256 ??= await computeLegacyPythonContentManifestSha256(sourceCheckoutPath);
						assert(
							proof.tree === treeOid &&
								record.before?.tree === treeOid &&
								record.after?.tree === treeOid &&
								record.before.contentManifestSha256 === proof.contentManifestSha256 &&
								record.after.contentManifestSha256 === proof.contentManifestSha256 &&
								SHA256_PATTERN.test(proof.contentManifestSha256) &&
								[contentManifestSha256, legacyPythonContentManifestSha256].includes(proof.contentManifestSha256),
							"备用验证没有绑定当前完整候选内容",
						);
						assert(
							record.argv?.length === 3 && record.argv[2] === phase && record.phase === phase,
							"备用验证阶段与实际 argv 不匹配",
						);
						const runnerPath = await verifyAndSnapshotEvidenceFile(
							record.argv[1],
							record.runnerSha256,
							directory,
							copies,
						);
						const runner = await readFile(runnerPath, "utf8");
						const nodeDirectory = /node_directory\s*=\s*pathlib.Path\('([^']+)'\)/.exec(runner)?.[1];
						const environmentCompatible =
							nodeDirectory &&
							(await realpath(join(nodeDirectory, "node"))) === currentEnvironment.nodeExecutable &&
							isExplicitRecordEnvironmentCompatible(record.validationEnvironment, currentEnvironment);
						precommitEnvironmentCompatible ||= Boolean(environmentCompatible);
						const commands = extractStaticallyBoundLegacyNpmCommands(runner, phase);
						let originalWrapperUnchanged = false;
						try {
							originalWrapperUnchanged =
								(await computeEvidenceFileSha256Once(record.argv[1])) === record.runnerSha256;
						} catch (error) {
							if (error.code !== "ENOENT") throw error;
						}
						const proofFiles = [recordPath, runnerPath];
						for (const stream of ["stdout", "stderr"])
							proofFiles.push(
								await verifyAndSnapshotEvidenceFile(
									record[`${stream}Path`],
									record[`${stream}Sha256`],
									directory,
									copies,
								),
							);
						sourceValidationCheckResults.push({
							commandKeys: [
								...commands.map((argv) => createSourceValidationCommandIdentityKey(argv, record.cwd)),
								...(originalWrapperUnchanged
									? [createSourceValidationCommandIdentityKey(record.argv, record.cwd)]
									: []),
							],
							argv: record.argv,
							coverage: [phase],
							taskId: bundle.taskId,
							evidencePath: proof.recordPath,
							evidenceSha256: proof.recordSha256,
							proofFiles,
							environmentCompatible: Boolean(environmentCompatible),
							status: isSourceValidationInterruptedExitCode(record.exitCode)
								? "interrupted"
								: record.status === "passed" && record.exitCode === 0
									? "passed"
									: "failed",
							sourceFormat: "final-complete-tree-verification-evidence",
							startedAt: record.startedAt,
							concludedAt: record.finishedAt,
						});
					} catch (error) {
						addIssue(proof.recordPath, error);
					}
				}
				if (bundle.precommit) {
					const precommit = bundle.precommit;
					assert(
						precommit.taskId === bundle.taskId &&
							precommit.commit === bundle.taskCommit &&
							precommit.completeTree === treeOid,
						"提交检查归属不一致",
					);
					const log = await verifyAndSnapshotEvidenceFile(
						precommit.rawLog,
						precommit.rawLogSha256,
						directory,
						copies,
					);
					assert(
						/vitest run --project precommit-safe/.test(await readFile(log, "utf8")),
						"提交检查原件未证明执行 precommit-safe",
					);
					sourceValidationCheckResults.push({
						commandKeys: [
							createSourceValidationCommandIdentityKey(["npm", "run", "test:precommit"], sourceCheckoutPath),
						],
						argv: ["npm", "run", "test:precommit"],
						coverage: ["precommit-safe"],
						taskId: bundle.taskId,
						evidencePath: bundlePath,
						evidenceSha256: await computeEvidenceFileSha256Once(bundlePath),
						proofFiles: [log],
						environmentCompatible: precommitEnvironmentCompatible,
						status: isSourceValidationInterruptedExitCode(precommit.exitCode)
							? "interrupted"
							: precommit.status === "passed" && precommit.exitCode === 0
								? "passed"
								: "failed",
						sourceFormat: "final-committed-full-tree-precommit-validation",
					});
				}
			}
		} catch (error) {
			addIssue(bundlePath, error);
		}
		if (remainingDepth > 0) {
			for (const name of await listEvidenceSubdirectoryNamesWithinBudget(directory)) {
				if (!name.startsWith(".") && !["node_modules", "validation-and-recovery-audit"].includes(name))
					await discoverBundles(join(directory, name), remainingDepth - 1);
			}
		}
	}
	for (const root of ["cross-task-handoff-artifacts", "task-cross-task-handoff-artifacts", "task-handoff-artifacts"])
		await discoverBundles(join(runtimeHomeDirectoryPath, root), 3);
	// 同步可直接采用 RVF 原件；没有新同步测试记录并不意味着原验证不存在。
	const rvfRuns = join(
		process.env.RVF_USER_LOCAL_DATA_ROOT || join(homedir(), ".rvf/user-local-data"),
		"task-snapshot-reviews",
	);
	for (const runName of await listEvidenceSubdirectoryNamesWithinBudget(rvfRuns)) {
		const runDirectory = join(rvfRuns, runName);
		try {
			const run = await readOptionalJsonEvidenceFile(join(runDirectory, "run.json"));
			if (!run || run.schema_version !== 1 || resolve(run.git_common_directory || "/") !== gitCommonDirectory)
				continue;
			const validation = await readOptionalJsonEvidenceFile(join(runDirectory, "validation.json"));
			if (!validation || validation.tested_tree !== treeOid) continue;
			assert(
				validation.candidate_commit === run.validated_candidate_commit &&
					runReadOnlyGitCommand(sourceCheckoutPath, [
						"rev-parse",
						`${validation.candidate_commit}^{tree}`,
					]).trim() === treeOid,
				"RVF 原验证没有绑定当前完整树",
			);
			const planPath = join(runDirectory, "execution-plan.json");
			assert(
				(await computeEvidenceFileSha256Once(planPath)) === run.execution_plan_sha256,
				"RVF 冻结执行计划摘要不匹配",
			);
			const executionPlan = await readBoundedJsonEvidenceFile(planPath);
			assert(
				JSON.stringify(validation.commands) === JSON.stringify(executionPlan.validation_commands) &&
					Number.isInteger(validation.completed_commands) &&
					validation.completed_commands >= 0 &&
					validation.completed_commands <= validation.commands.length,
				"RVF 冻结计划或已执行命令计数不一致",
			);
			assert(
				isAbsolute(validation.attempt_directory) &&
					isPathInsideDirectory(runDirectory, validation.attempt_directory),
				"RVF attempt 越出原 run",
			);
			const nativeNode = executionPlan.machine_context?.native_node;
			for (let index = 0; index < validation.commands.length; index++) {
				const directory = join(validation.attempt_directory, `command-${String(index + 1).padStart(3, "0")}`);
				const execution = await readOptionalJsonEvidenceFile(join(directory, "execution.json"));
				if (!execution) continue;
				const supervision = await readBoundedJsonEvidenceFile(join(directory, "command-supervision.json"));
				assert(
					JSON.stringify(execution.argv) === JSON.stringify(validation.commands[index]) &&
						JSON.stringify(supervision.argv) === JSON.stringify(execution.argv),
					"RVF 命令身份不一致",
				);
				assert(
					execution.source_tree_before === treeOid &&
						execution.source_tree_after === treeOid &&
						supervision.status === "completed" &&
						supervision.owned_process_exit_status === "exited" &&
						supervision.command_execution_started === true,
					"RVF 原生命令未证明同树完成与子进程退出",
				);
				const proofFiles = [];
				for (const stream of ["stdout", "stderr"])
					proofFiles.push(
						await verifyAndSnapshotEvidenceFile(
							join(directory, `${stream}.txt`),
							supervision[`${stream}_sha256`],
							runDirectory,
						),
					);
				for (const name of ["execution.json", "command-supervision.json"])
					proofFiles.push(
						await verifyAndSnapshotEvidenceFile(
							join(directory, name),
							await computeEvidenceFileSha256Once(join(directory, name)),
							runDirectory,
						),
					);
				const externalWrapper = execution.argv
					.slice(1)
					.some(
						(argument) =>
							/\.(?:py|sh|bash|js|mjs|cjs)$/.test(argument) &&
							isAbsolute(argument) &&
							!isPathInsideDirectory(execution.cwd, argument),
					);
				const actualNode = nativeNode || (basename(execution.argv[0]) === "node" ? execution.argv[0] : null);
				const environmentCompatible =
					!externalWrapper &&
					Boolean(actualNode) &&
					(await realpath(actualNode)) === currentEnvironment.nodeExecutable &&
					isRvfNativeRecordEnvironmentCompatible(validation);
				const validationToolUnavailable =
					execution.returncode === 127 &&
					supervision.returncode === 127 &&
					/^sh: (?:\d+: )?(?:tsc|tsx|vitest|biome): (?:command )?not found\s*$/.test(
						await readFile(join(directory, "stderr.txt"), "utf8"),
					);
				sourceValidationCheckResults.push({
					commandKeys: [createSourceValidationCommandIdentityKey(execution.argv, execution.cwd)],
					argv: execution.argv,
					coverage: ["rvf-original-validation-command"],
					taskId: executionPlan.machine_context?.task_id || null,
					evidencePath: join(directory, "execution.json"),
					evidenceSha256: await computeEvidenceFileSha256Once(join(directory, "execution.json")),
					proofFiles,
					environmentCompatible: Boolean(environmentCompatible),
					status:
						validationToolUnavailable
							? "validation_environment_unavailable"
							: execution.status === "passed" && execution.returncode === 0 && supervision.returncode === 0
								? "passed"
								: "failed",
					sourceFormat: "rvf-task-snapshot-original-validation",
					originalRunId: run.run_id,
					startedAt: execution.started_at || supervision.started_at,
					concludedAt: execution.finished_at || supervision.finished_at,
					...(validationToolUnavailable
						? { ineligibleReason: "历史 shell 缺少验证工具，未形成源码质量结论；保留原件并补验缺项" }
						: externalWrapper
							? { ineligibleReason: "原记录未冻结仓库外包装脚本，不能假定其内容始终不变" }
							: {}),
				});
			}
		} catch (error) {
			addIssue(join(runDirectory, "validation.json"), error);
		}
	}
	return sourceValidationCheckResults;
}

function validateFrozenSourceValidationPlan(plan) {
	assert(
		plan.schemaVersion === 1 && Array.isArray(plan.commands) && plan.commands.length > 0,
		"必须提供非空 schemaVersion=1 验证计划，不默认运行全量测试",
	);
	for (const command of plan.commands) {
		assert(
			typeof command.name === "string" && command.name && stringArray(command.argv),
			"验证计划缺少名称或实际 argv",
		);
		const effectiveArgv = [...command.argv];
		if (basename(effectiveArgv[0]) === "env") {
			effectiveArgv.shift();
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(effectiveArgv[0] || "")) effectiveArgv.shift();
			assert(effectiveArgv[0] && !effectiveArgv[0].startsWith("-"), "env 仅支持明确的变量赋值和源码检查命令");
		}
		assert(
			!["git", "bash", "sh", "zsh", "kanban"].includes(basename(effectiveArgv[0])),
			"验证计划不得执行 Git、shell 或部署命令",
		);
		if (basename(effectiveArgv[0]) === "npm") {
			const action = effectiveArgv[effectiveArgv.indexOf("run") + 1];
			assert(
				effectiveArgv.includes("run") &&
					/^(?:typecheck|lint|check|test(?::[a-z-]+)?|web:(?:test|typecheck))$/.test(action),
				"npm 计划只能声明源码检查，不得构建、安装、发布或重启",
			);
		}
		assert(
			command.timeoutMs === undefined ||
				(Number.isInteger(command.timeoutMs) && command.timeoutMs > 0 && command.timeoutMs <= 3_600_000),
			"检查超时必须在一小时以内",
		);
	}
}

function readProcessStartIdentity(pid) {
	const observed = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
	return observed.status === 0 ? observed.stdout.trim() || null : null;
}

function isRecordedProcessStillRunning(pid, expectedStartIdentity = null) {
	try {
		process.kill(pid, 0);
		const currentIdentity = expectedStartIdentity ? readProcessStartIdentity(pid) : null;
		return !currentIdentity || currentIdentity === expectedStartIdentity;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		return true;
	}
}

function isRecordedProcessGroupStillRunning(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		return true;
	}
}

async function acquireSourceValidationOutputOwnership() {
	const path = join(sourceValidationOutputDirectory, "source-validation-preparation-owner.json");
	const ownershipToken = randomUUID();
	const preparedPath = `${path}.${ownershipToken}.prepared`;
	const file = await open(preparedPath, "wx", 0o600);
	try {
		await file.writeFile(
			JSON.stringify({
				processId: process.pid,
				processStartIdentity: readProcessStartIdentity(process.pid),
				ownershipToken,
			}),
		);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		// 完整持久化后再原子认领，进程退出不能留下半份归属记录挡住恢复。
		await link(preparedPath, path);
		const directory = await open(sourceValidationOutputDirectory, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return async () => {
			const owner = await readBoundedJsonEvidenceFile(path);
			assert(owner.ownershipToken === ownershipToken, "源码验证的执行归属已变化，不能删除其他执行者的归属记录");
			await unlink(path);
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = await readBoundedJsonEvidenceFile(path);
		assert(
			Number.isInteger(owner.processId) &&
				!isRecordedProcessStillRunning(owner.processId, owner.processStartIdentity),
			"同一报告已有执行者，等待其退出后自动接续",
		);
		await unlink(path);
		return acquireSourceValidationOutputOwnership();
	} finally {
		await unlink(preparedPath);
	}
}

function findSourceValidationSupervisorProcess(launchToken) {
	const observed = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C" },
	});
	if (observed.status !== 0) return { available: false, processId: null };
	const line = observed.stdout.split("\n").find((entry) => entry.includes(launchToken));
	const processId = line ? Number.parseInt(line.trim(), 10) : null;
	return { available: true, processId: Number.isInteger(processId) ? processId : null };
}

function sourceValidationAttemptPredatesCurrentBoot(attempt) {
	const startedAt = Date.parse(attempt.startedAt);
	return Number.isFinite(startedAt) && startedAt < Date.now() - uptime() * 1000;
}

async function finalizeSourceValidationAttempt(
	attempt,
	result,
	state,
	statePath,
	sourceCheckoutPath,
	expectedSourceSnapshot,
) {
	let sourceRemainedUnchanged = false;
	try {
		sourceRemainedUnchanged =
			JSON.stringify(
				await captureVerifiedCandidateSourceSnapshot(sourceCheckoutPath, expectedSourceSnapshot.commit),
			) === JSON.stringify(expectedSourceSnapshot.snapshot);
	} catch (error) {
		attempt.sourceSnapshotRejectionReason = String(error.message || error);
	}
	Object.assign(attempt, result, {
		childProcessId: result.childProcessId ?? attempt.childProcessId ?? null,
		childProcessStartIdentity: result.childProcessStartIdentity ?? attempt.childProcessStartIdentity ?? null,
		status: !sourceRemainedUnchanged
			? "source_changed_during_validation"
			: attempt.spawnError ||
					result.spawnError ||
					result.exitCode === null ||
					isSourceValidationInterruptedExitCode(result.exitCode) ||
					result.interrupted ||
					stopped
				? "interrupted"
				: result.exitCode === 0
					? "passed"
					: "failed",
		stdoutSha256: await computeEvidenceFileSha256Once(attempt.stdoutPath),
		stderrSha256: await computeEvidenceFileSha256Once(attempt.stderrPath),
		concludedAt: result.concludedAt || new Date().toISOString(),
	});
	await writeJsonFileDurablyWhenChanged(statePath, state);
}

async function interruptSourceValidationAttempt(attempt, state, statePath, reason) {
	Object.assign(attempt, { status: "interrupted", recoveryReason: reason, concludedAt: new Date().toISOString() });
	await writeJsonFileDurablyWhenChanged(statePath, state);
}

async function reconcileRunningSourceValidationAttempt(
	attempt,
	state,
	statePath,
	sourceCheckoutPath,
	expectedSourceSnapshot,
) {
	if (attempt.nativeSupervisionPath && attempt.launchToken) {
		const supervision = await readOptionalJsonEvidenceFile(attempt.nativeSupervisionPath);
		if (supervision) {
			assert(
				supervision.launchToken === attempt.launchToken &&
					JSON.stringify(supervision.argv) === JSON.stringify(attempt.argv),
				"原验证监督记录与接续尝试不匹配",
			);
			if (supervision.status === "completed") {
				await finalizeSourceValidationAttempt(
					attempt,
					supervision,
					state,
					statePath,
					sourceCheckoutPath,
					expectedSourceSnapshot,
				);
				return "completed";
			}
			const processAlive = [
				[supervision.supervisorProcessId, supervision.supervisorProcessStartIdentity],
				[supervision.childProcessId, supervision.childProcessStartIdentity],
			].some(([pid, startIdentity]) => pid && isRecordedProcessStillRunning(pid, startIdentity));
			if (processAlive) return "running";
			const hasNativeProcessGroup =
				Number.isInteger(supervision.processGroupId) &&
				supervision.processGroupId > 0 &&
				supervision.processGroupId === supervision.supervisorProcessId;
			if (!supervision.childProcessId && hasNativeProcessGroup) {
				if (isRecordedProcessGroupStillRunning(supervision.processGroupId)) return "running";
			} else if (!supervision.childProcessId && !sourceValidationAttemptPredatesCurrentBoot(attempt)) {
				return "running";
			}
			await interruptSourceValidationAttempt(
				attempt,
				state,
				statePath,
				"监督进程与实际子进程均已退出，原尝试按中断接续",
			);
			return "interrupted";
		}
		if (
			attempt.childProcessId &&
			isRecordedProcessStillRunning(attempt.childProcessId, attempt.childProcessStartIdentity)
		)
			return "running";
		const observed = findSourceValidationSupervisorProcess(attempt.launchToken);
		if (!observed.available) return "running";
		if (observed.processId) {
			attempt.supervisorProcessId = observed.processId;
			attempt.supervisorProcessStartIdentity = readProcessStartIdentity(observed.processId);
			await writeJsonFileDurablyWhenChanged(statePath, state);
			return "running";
		}
		await interruptSourceValidationAttempt(
			attempt,
			state,
			statePath,
			"唯一启动标识没有存活监督进程，确认无需继续等待后接续",
		);
		return "interrupted";
	}
	if (attempt.childProcessId) {
		if (isRecordedProcessStillRunning(attempt.childProcessId, attempt.childProcessStartIdentity)) return "running";
		await interruptSourceValidationAttempt(attempt, state, statePath, "旧格式记录的实际子进程已退出");
		return "interrupted";
	}
	if (sourceValidationAttemptPredatesCurrentBoot(attempt)) {
		await interruptSourceValidationAttempt(attempt, state, statePath, "旧格式尝试早于本次系统启动，可安全接续");
		return "interrupted";
	}
	return "running";
}

async function executeMissingSourceValidationCheckWithResume(
	command,
	key,
	state,
	statePath,
	sourceCheckoutPath,
	contextFingerprint,
	commandFingerprint,
	expectedSourceSnapshot,
) {
	const commandIdentity = createSourceValidationCommandIdentityKey(command.argv, sourceCheckoutPath);
	for (const attempt of state.attempts) {
		if (attempt.sourceValidationCommandIdentityKey !== commandIdentity || attempt.status !== "running") continue;
		if (
			(await reconcileRunningSourceValidationAttempt(
				attempt,
				state,
				statePath,
				sourceCheckoutPath,
				expectedSourceSnapshot,
			)) === "running"
		)
			return {
				name: command.name,
				decision: "machine_evidence_pending",
				reason: "同项原验证监督或子进程尚未确认退出，不重复执行",
			};
	}
	const previous = state.attempts.filter((attempt) => attempt.checkKey === key);
	const sameCheck = state.attempts.filter(
		(attempt) =>
			attempt.contextFingerprintSha256 === contextFingerprint &&
			attempt.commandEnvironmentFingerprintSha256 === commandFingerprint &&
			attempt.sourceValidationCommandIdentityKey === commandIdentity,
	);
	const previousConclusion = sameCheck.findLast((attempt) => ["passed", "failed"].includes(attempt.status));
	if (previousConclusion?.status === "failed")
		return { name: command.name, decision: "quality_validation_failed", evidencePath: statePath };
	const completed = sameCheck.findLast((attempt) => attempt.status === "passed");
	if (completed) {
		for (const stream of ["stdout", "stderr"])
			assert(
				(await computeEvidenceFileSha256Once(completed[`${stream}Path`])) === completed[`${stream}Sha256`],
				"已完成检查的日志损坏",
			);
		return { ...completed, decision: "reused_previous_execution" };
	}
	if (previous.length >= 2)
		return {
			name: command.name,
			decision: "machine_evidence_pending",
			reason: "同一输入的两次执行预算已用完；候选、计划或环境变化后重验",
		};
	if (stopped)
		return { name: command.name, decision: "machine_evidence_pending", reason: "已收到 Stop，不启动后续检查" };
	assert(
		JSON.stringify(
			await captureVerifiedCandidateSourceSnapshot(sourceCheckoutPath, expectedSourceSnapshot.commit),
		) === JSON.stringify(expectedSourceSnapshot.snapshot),
		"补验开始前候选发生变化",
	);
	const attemptDirectory = join(
		sourceValidationOutputDirectory,
		"source-validation-command-originals",
		key,
		String(previous.length + 1),
	);
	await mkdir(attemptDirectory, { recursive: true });
	const attempt = {
		name: command.name,
		checkKey: key,
		contextFingerprintSha256: contextFingerprint,
		commandEnvironmentFingerprintSha256: commandFingerprint,
		sourceValidationCommandIdentityKey: commandIdentity,
		argv: command.argv,
		cwd: sourceCheckoutPath,
		status: "running",
		startedAt: new Date().toISOString(),
		launchToken: randomUUID(),
		nativeSupervisionPath: join(attemptDirectory, "native-supervision.json"),
		stdoutPath: join(attemptDirectory, "stdout"),
		stderrPath: join(attemptDirectory, "stderr"),
	};
	state.attempts.push(attempt);
	await writeJsonFileDurablyWhenChanged(statePath, state);
	const stdout = await open(attempt.stdoutPath, "wx", 0o600);
	const stderr = await open(attempt.stderrPath, "wx", 0o600);
	try {
		const result = await new Promise((resolveResult) => {
			const supervisor = spawn(
				process.execPath,
				[
					fileURLToPath(import.meta.url),
					"--supervise-source-validation-check",
					"--record",
					attempt.nativeSupervisionPath,
					"--cwd",
					sourceCheckoutPath,
					"--timeout-ms",
					String(command.timeoutMs ?? 900_000),
					"--launch-token",
					attempt.launchToken,
					"--",
					...command.argv,
				],
				{
					cwd: sourceCheckoutPath,
					detached: true,
					stdio: ["ignore", stdout.fd, stderr.fd],
					env: currentSourceValidationProcessEnvironment(),
				},
			);
			activeChild = supervisor;
			attempt.supervisorProcessId = supervisor.pid ?? null;
			attempt.supervisorProcessStartIdentity = supervisor.pid
				? readProcessStartIdentity(supervisor.pid)
				: null;
			const persisted = writeJsonFileDurablyWhenChanged(statePath, state);
			supervisor.once("error", (error) => {
				attempt.spawnError = error.message;
			});
			supervisor.once("close", async (_exitCode, signal) => {
				try {
					await persisted;
					const supervision = await readOptionalJsonEvidenceFile(attempt.nativeSupervisionPath);
					resolveResult(
						supervision?.status === "completed"
							? supervision
							: { exitCode: null, signal, interrupted: true },
					);
				} catch (error) {
					resolveResult({ exitCode: null, signal: null, persistenceError: error.message, interrupted: true });
				}
			});
		});
		activeChild = null;
		await stdout.sync();
		await stderr.sync();
		await finalizeSourceValidationAttempt(
			attempt,
			result,
			state,
			statePath,
			sourceCheckoutPath,
			expectedSourceSnapshot,
		);
		return {
			...attempt,
			decision:
				attempt.status === "passed"
					? "executed_missing_check"
					: ["interrupted", "source_changed_during_validation"].includes(attempt.status)
						? "machine_evidence_pending"
						: "quality_validation_failed",
		};
	} finally {
		await stdout.close();
		await stderr.close();
	}
}

async function superviseSourceValidationCheck() {
	const separator = process.argv.indexOf("--", 3);
	assert(separator > 0, "监督命令缺少实际 argv 分隔符");
	const { values } = parseArgs({
		args: process.argv.slice(3, separator),
		options: {
			record: { type: "string" },
			cwd: { type: "string" },
			"timeout-ms": { type: "string" },
			"launch-token": { type: "string" },
		},
	});
	const argv = process.argv.slice(separator + 1);
	assert(
		stringArray(argv) && isAbsolute(values.record || "") && isAbsolute(values.cwd || "") && values["launch-token"],
		"监督记录、工作目录、启动标识或实际 argv 缺失",
	);
	const timeoutMs = Number(values["timeout-ms"]);
	assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000, "监督超时无效");
	const record = {
		schemaVersion: 1,
		launchToken: values["launch-token"],
		argv,
		supervisorProcessId: process.pid,
		supervisorProcessStartIdentity: readProcessStartIdentity(process.pid),
		processGroupId: process.pid,
		status: "running",
		startedAt: new Date().toISOString(),
	};
	await writeJsonFileDurablyWhenChanged(values.record, record);
	const child = spawn(argv[0], argv.slice(1), {
		cwd: values.cwd,
		detached: false,
		stdio: ["ignore", 1, 2],
		env: currentSourceValidationProcessEnvironment(),
	});
	activeChild = child;
	record.childProcessId = child.pid ?? null;
	record.childProcessStartIdentity = child.pid ? readProcessStartIdentity(child.pid) : null;
	const timeout = setTimeout(() => {
		try {
			process.kill(-process.pid, "SIGKILL");
		} catch {}
	}, timeoutMs);
	const completed = new Promise((resolveCompleted) => {
		child.once("error", (error) => {
			record.spawnError = error.message;
		});
		child.once("close", (exitCode, signal) => {
			resolveCompleted({ exitCode, signal });
		});
	});
	await writeJsonFileDurablyWhenChanged(values.record, record);
	const result = await completed;
	clearTimeout(timeout);
	Object.assign(record, result, {
		status: "completed",
		interrupted: stopped || result.exitCode === null || isSourceValidationInterruptedExitCode(result.exitCode),
		concludedAt: new Date().toISOString(),
	});
	await writeJsonFileDurablyWhenChanged(values.record, record);
}

async function readSourceValidationEnvironmentIdentity(sourceCheckoutPath) {
	const validationEnvironmentIdentity = {
		nodeExecutable: await realpath(process.execPath),
		nodeVersion: process.versions.node,
		nodeModulesAbi: process.versions.modules,
		platform: process.platform,
		architecture: process.arch,
		lockfiles: {},
		installedDependencyMetadata: {},
		processEnvironmentSha256: sha256(
			serializePythonCompatibleCommandFingerprintJson(currentSourceValidationProcessEnvironment()),
		),
	};
	for (const project of [".", "web-ui", "packages/desktop"]) {
		try {
			validationEnvironmentIdentity.lockfiles[project] = await computeEvidenceFileSha256Once(
				join(sourceCheckoutPath, project, "package-lock.json"),
			);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		try {
			validationEnvironmentIdentity.installedDependencyMetadata[project] = await computeEvidenceFileSha256Once(
				await realpath(join(sourceCheckoutPath, project, "node_modules/.package-lock.json")),
			);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return validationEnvironmentIdentity;
}

async function observeSourceValidationAttemptProcess(attempt) {
	if (attempt.nativeSupervisionPath && attempt.launchToken) {
		const supervision = await readOptionalJsonEvidenceFile(attempt.nativeSupervisionPath);
		if (supervision?.status === "completed") return false;
		if (supervision) {
			const alive = [
				[supervision.supervisorProcessId, supervision.supervisorProcessStartIdentity],
				[supervision.childProcessId, supervision.childProcessStartIdentity],
			].some(([pid, startIdentity]) => pid && isRecordedProcessStillRunning(pid, startIdentity));
			if (alive) return true;
			const hasNativeProcessGroup =
				Number.isInteger(supervision.processGroupId) &&
				supervision.processGroupId > 0 &&
				supervision.processGroupId === supervision.supervisorProcessId;
			if (!supervision.childProcessId && hasNativeProcessGroup)
				return isRecordedProcessGroupStillRunning(supervision.processGroupId);
			return !supervision.childProcessId && !sourceValidationAttemptPredatesCurrentBoot(attempt) ? "unknown" : false;
		}
		if (
			attempt.childProcessId &&
			isRecordedProcessStillRunning(attempt.childProcessId, attempt.childProcessStartIdentity)
		)
			return true;
		const observed = findSourceValidationSupervisorProcess(attempt.launchToken);
		return observed.available ? Boolean(observed.processId) : "unknown";
	}
	if (attempt.childProcessId)
		return isRecordedProcessStillRunning(attempt.childProcessId, attempt.childProcessStartIdentity);
	return sourceValidationAttemptPredatesCurrentBoot(attempt) ? false : "unknown";
}

async function observeSourceValidationRecoveryEvidence(values, sourceCheckoutPath, commit) {
	readOnlyRecoveryObservation = true;
	const state = await readOptionalJsonEvidenceFile(
		join(sourceValidationOutputDirectory, "source-validation-execution-state.json"),
	);
	const gitCommonDirectory = resolve(
		sourceCheckoutPath,
		runReadOnlyGitCommand(sourceCheckoutPath, ["rev-parse", "--git-common-dir"]).trim(),
	);
	let candidateSourceObservation;
	const validationEnvironmentIdentity = await readSourceValidationEnvironmentIdentity(sourceCheckoutPath);
	try {
		const snapshot = await captureVerifiedCandidateSourceSnapshot(sourceCheckoutPath, commit);
		const available = await discoverReusableSourceValidationChecks(
			sourceCheckoutPath,
			gitCommonDirectory,
			snapshot.treeOid,
			snapshot.contentManifestSha256,
			values["runtime-home-directory"],
			validationEnvironmentIdentity,
		);
		candidateSourceObservation = {
			snapshot,
			evidence: available.map((check) => [
				check.evidencePath,
				check.evidenceSha256,
				check.status,
				check.environmentCompatible,
			]),
			evidenceDiscoveryIssues,
		};
	} catch (error) {
		candidateSourceObservation = { unavailableReason: String(error.message || error) };
	}
	const semanticObservation = {
		candidateSourceObservation,
		validationEnvironmentIdentity,
		validationPlan: values["validation-plan"] ? await readOptionalJsonEvidenceFile(values["validation-plan"]) : null,
		unfinishedChecks: await Promise.all(
			(state?.attempts || [])
				.filter((attempt) => ["running", "interrupted"].includes(attempt.status))
				.map(async (attempt) => ({
					checkKey: attempt.checkKey,
					status: attempt.status,
					processStillRunning: await observeSourceValidationAttemptProcess(attempt),
				})),
		),
	};
	process.stdout.write(
		`${JSON.stringify({
			evidenceSha256: sha256(JSON.stringify(semanticObservation)),
			sourceValidationDiscoveryCompleted: Boolean(candidateSourceObservation.snapshot),
		})}\n`,
	);
}

async function main() {
	const { values } = parseArgs({
		options: {
			"source-checkout-path": { type: "string" },
			"candidate-source-commit": { type: "string" },
			"runtime-home-directory": { type: "string" },
			"output-directory": { type: "string" },
			"validation-plan": { type: "string" },
			"inspect-only": { type: "boolean", default: false },
			"observe-recovery-evidence": { type: "boolean", default: false },
		},
	});
	for (const key of ["source-checkout-path", "runtime-home-directory", "output-directory"])
		assert(values[key] && isAbsolute(values[key]), `必须提供绝对路径 --${key}`);
	const sourceCheckoutPath = await realpath(values["source-checkout-path"]);
	const commit = values["candidate-source-commit"];
	assert(OBJECT_ID_PATTERN.test(commit || ""), "候选必须是完整 commit SHA，不能使用 HEAD/latest 等浮动引用");
	sourceValidationOutputDirectory = await resolveProspectiveDirectoryRealpath(values["output-directory"]);
	assert(
		!isPathInsideDirectory(sourceCheckoutPath, sourceValidationOutputDirectory),
		"报告必须写入源码目录之外的持久位置",
	);
	if (values["observe-recovery-evidence"])
		return observeSourceValidationRecoveryEvidence(values, sourceCheckoutPath, commit);
	await mkdir(sourceValidationOutputDirectory, { recursive: true });
	const release = await acquireSourceValidationOutputOwnership();
	try {
		const frozenPreparerSha256 = sha256(sourceValidationPreparerContents);
		const frozenPreparerPath = join(
			sourceValidationOutputDirectory,
			`frozen-source-validation-preparer-${frozenPreparerSha256}.mjs`,
		);
		let existingFrozenBytes = null;
		try {
			existingFrozenBytes = await readFile(frozenPreparerPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (!existingFrozenBytes || sha256(existingFrozenBytes) !== frozenPreparerSha256) {
			if (existingFrozenBytes)
				await rename(frozenPreparerPath, `${frozenPreparerPath}.rejected-${sha256(existingFrozenBytes)}`);
			const frozen = await open(frozenPreparerPath, "wx", 0o600);
			try {
				await frozen.writeFile(sourceValidationPreparerContents);
				await frozen.sync();
			} finally {
				await frozen.close();
			}
		}
		const preparationCommand = [
			process.execPath,
			frozenPreparerPath,
			"--source-checkout-path",
			sourceCheckoutPath,
			"--candidate-source-commit",
			commit,
			"--runtime-home-directory",
			values["runtime-home-directory"],
			"--output-directory",
			sourceValidationOutputDirectory,
			...(values["validation-plan"] ? ["--validation-plan", resolve(values["validation-plan"])] : []),
		];
		const gitCommonDirectory = resolve(
			sourceCheckoutPath,
			runReadOnlyGitCommand(sourceCheckoutPath, ["rev-parse", "--git-common-dir"]).trim(),
		);
		const { treeOid, contentManifestSha256 } = await captureVerifiedCandidateSourceSnapshot(
			sourceCheckoutPath,
			commit,
		);
		const validationEnvironmentIdentity = await readSourceValidationEnvironmentIdentity(sourceCheckoutPath);
		const availableSourceValidationChecks = await discoverReusableSourceValidationChecks(
			sourceCheckoutPath,
			gitCommonDirectory,
			treeOid,
			contentManifestSha256,
			values["runtime-home-directory"],
			validationEnvironmentIdentity,
		);
		const plan = values["validation-plan"] ? await readBoundedJsonEvidenceFile(values["validation-plan"]) : null;
		if (plan) validateFrozenSourceValidationPlan(plan);
		const contextFingerprint = sha256(
			JSON.stringify({
				sourceCheckoutPath: sourceCheckoutPath,
				gitCommonDirectory: gitCommonDirectory,
				treeOid,
				contentManifestSha256,
				validationEnvironmentIdentity,
			}),
		);
		const statePath = join(sourceValidationOutputDirectory, "source-validation-execution-state.json");
		const state = (await readOptionalJsonEvidenceFile(statePath)) || { schemaVersion: 1, attempts: [] };
		assert(state.schemaVersion === 1 && Array.isArray(state.attempts), "验证接续记录格式不合法");
		for (const imported of state.importedEvidence || []) {
			if (imported.contextFingerprintSha256 !== contextFingerprint) continue;
			try {
				assert(sha256(JSON.stringify(imported.check)) === imported.checkSha256, "已接受证据的接续记录摘要不匹配");
				try {
					await lstat(imported.check.evidencePath);
					continue;
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				for (const snapshot of imported.snapshots) {
					assert(
						isPathInsideDirectory(sourceValidationOutputDirectory, resolve(snapshot.snapshotPath)) &&
							(await computeEvidenceFileSha256Once(snapshot.snapshotPath)) === snapshot.sha256,
						"已消费证据的持久副本损坏",
					);
					evidenceSnapshots.set(snapshot.sha256, snapshot);
				}
				availableSourceValidationChecks.push(imported.check);
			} catch (error) {
				evidenceDiscoveryIssues.push({ evidencePath: imported.check?.evidencePath, reason: error.message });
			}
		}
		const fingerprint = sha256(
			JSON.stringify({
				contextFingerprint,
				plan,
				evidence: availableSourceValidationChecks
					.map((check) => [check.evidencePath, check.evidenceSha256, check.status, check.environmentCompatible])
					.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
			}),
		);
		const sourceValidationCheckResults = [];
		for (const command of plan?.commands || []) {
			const commandIdentity = createSourceValidationCommandIdentityKey(command.argv, sourceCheckoutPath);
			const commandFingerprint = await computeSourceValidationCommandEnvironmentFingerprint(
				command.argv,
				sourceCheckoutPath,
			);
			const checkKey = sha256(`${fingerprint}:${commandIdentity}:${commandFingerprint}`);
			const matches = availableSourceValidationChecks.filter((record) => record.commandKeys.includes(commandIdentity));
			const previousConclusion = state.attempts.findLast(
				(attempt) =>
					attempt.contextFingerprintSha256 === contextFingerprint &&
					attempt.commandEnvironmentFingerprintSha256 === commandFingerprint &&
					attempt.sourceValidationCommandIdentityKey === commandIdentity &&
					["passed", "failed"].includes(attempt.status),
			);
			const latest = selectLatestSourceValidationConclusion([
				...matches,
				...(previousConclusion ? [previousConclusion] : []),
			]);
			if (latest?.status === "failed")
				sourceValidationCheckResults.push({
					name: command.name,
					decision: "quality_validation_failed",
					reason: "当前完整树有尚未被后续记录替代的同项失败",
					evidencePath: latest.evidencePath || statePath,
				});
			else if (latest?.status === "passed" && latest.commandKeys && latest.environmentCompatible)
				sourceValidationCheckResults.push({
					name: command.name,
					decision: "reused_source_evidence",
					evidencePath: latest.evidencePath,
					evidenceSha256: latest.evidenceSha256,
				});
			else if (values["inspect-only"])
				sourceValidationCheckResults.push({
					name: command.name,
					decision: "missing_check",
					reason: "没有同候选、同命令及可比较实际环境的有效证据",
				});
			else
				sourceValidationCheckResults.push(
					await executeMissingSourceValidationCheckWithResume(
						command,
						checkKey,
						state,
						statePath,
						sourceCheckoutPath,
						contextFingerprint,
						commandFingerprint,
						{ commit, snapshot: { treeOid, contentManifestSha256 } },
					),
				);
			if (sourceValidationCheckResults.at(-1).decision === "quality_validation_failed" || stopped) break;
		}
		assert(
			JSON.stringify(await captureVerifiedCandidateSourceSnapshot(sourceCheckoutPath, commit)) ===
				JSON.stringify({ treeOid, contentManifestSha256 }),
			"验证期间源码内容改变，不能消费本次结论",
		);
		const status = values["inspect-only"]
			? "inspection_complete"
			: !plan
				? "machine_evidence_pending"
				: sourceValidationCheckResults.some((result) => result.decision === "quality_validation_failed")
					? "quality_validation_failed"
					: sourceValidationCheckResults.some((result) => result.decision === "machine_evidence_pending") ||
							stopped
						? "machine_evidence_pending"
						: "passed";
		const reportPath = join(sourceValidationOutputDirectory, REPORT_FILENAME);
		state.importedEvidence = [
			...(state.importedEvidence || []).filter((entry) => entry.contextFingerprintSha256 !== contextFingerprint),
			...availableSourceValidationChecks.map((check) => ({
				contextFingerprintSha256: contextFingerprint,
				check,
				checkSha256: sha256(JSON.stringify(check)),
				snapshots: [...evidenceSnapshots.values()],
			})),
		];
		await writeJsonFileDurablyWhenChanged(statePath, state);
		const report = {
			sourceValidationPreparationCommand: preparationCommand,
			readOnlyRecoveryEvidenceObservationCommand: [...preparationCommand, "--observe-recovery-evidence"],
			frozenSourceValidationPreparerSha256: frozenPreparerSha256,
			schemaVersion: 1,
			kind: "local-deployment-source-validation-evidence-reuse",
			candidateSourceCommit: commit,
			treeOid,
			contentManifestSha256,
			gitCommonDirectory: gitCommonDirectory,
			sourceCheckoutPath: sourceCheckoutPath,
			validationEnvironmentIdentity,
			inputFingerprintSha256: fingerprint,
			status,
			currentDeploymentEnvironmentVerification: "required_separately",
			availableSourceValidationChecks,
			sourceValidationCheckResults: sourceValidationCheckResults,
			evidenceDiscoveryIssues,
			consumedEvidenceSnapshots: [...evidenceSnapshots.values()],
			evidenceVerificationStatistics,
			recoveryEvidenceFilePaths: [
				frozenPreparerPath,
				reportPath,
				statePath,
				...(values["validation-plan"] ? [resolve(values["validation-plan"])] : []),
				...Array.from(evidenceSnapshots.values(), (entry) => entry.snapshotPath),
			],
		};
		await writeJsonFileDurablyWhenChanged(reportPath, report);
		const summary = {
			ok: status === "passed",
			status,
			reportPath,
			candidateSourceCommit: commit,
			treeOid,
			availableSourceValidationCheckCount: availableSourceValidationChecks.length,
			reusedSourceValidationCheckCount: sourceValidationCheckResults.filter((result) =>
				result.decision.startsWith("reused_"),
			).length,
			executedMissingSourceValidationCheckCount: sourceValidationCheckResults.filter(
				(result) => result.decision === "executed_missing_check",
			).length,
			unresolvedSourceValidationCheckCount: sourceValidationCheckResults.filter((result) =>
				["missing_check", "machine_evidence_pending", "quality_validation_failed"].includes(result.decision),
			).length,
			evidenceDiscoveryIssueCount: evidenceDiscoveryIssues.length,
			evidenceVerificationStatistics,
		};
		process.stdout.write(`${JSON.stringify(summary)}\n`);
		process.exitCode =
			status === "passed" || status === "inspection_complete" ? 0 : status === "quality_validation_failed" ? 1 : 2;
	} catch (error) {
		await writeJsonFileDurablyWhenChanged(join(sourceValidationOutputDirectory, REPORT_FILENAME), {
			schemaVersion: 1,
			kind: "local-deployment-source-validation-evidence-reuse",
			candidateSourceCommit: commit,
			status: "machine_evidence_pending",
			reason: String(error.message || error),
		});
		throw error;
	} finally {
		await release();
	}
}

if (process.argv[2] === "--supervise-source-validation-check") {
	superviseSourceValidationCheck().catch(() => {
		process.exitCode = 2;
	});
} else {
	main().catch((error) => {
		process.stdout.write(
			`${JSON.stringify({ ok: false, status: "machine_evidence_pending", reason: String(error.message || error) })}\n`,
		);
		process.exitCode = 2;
	});
}
