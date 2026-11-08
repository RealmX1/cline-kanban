import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const assetsDirectory = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(assetsDirectory, "natural-writer-trust-continuity-baseline.json");
const journalPath = join(assetsDirectory, "natural-writer-trust-continuity-observations.jsonl");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readOptionalJson(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function installedPluginContentSnapshot(directory) {
	const entries = [];
	async function visit(path) {
		const metadata = await lstat(path, { bigint: true });
		const name = relative(directory, path);
		if (metadata.isDirectory()) {
			entries.push([name, "directory", String(metadata.dev), String(metadata.ino), String(metadata.mode)]);
			for (const child of (await readdir(path)).sort()) await visit(join(path, child));
		} else if (metadata.isSymbolicLink()) entries.push([name, "symlink", await readlink(path)]);
		else if (metadata.isFile()) entries.push([name, "file", String(metadata.mode), String(metadata.mtimeNs), createHash("sha256").update(await readFile(path)).digest("hex")]);
		else throw new Error("插件包含无法核验的文件类型，保留待验。");
	}
	await visit(directory);
	return digest(entries);
}

async function qualifiedWriterSnapshot(binding, runtimeHome) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	const evidence = shared?.nativeCapabilityEvidence;
	if (!evidence?.evidencePath || evidence.probeProtocolRevision !== 1) return null;
	const relativeEvidence = relative(join(runtimeHome, "codex-native-plugin-installation-capability-evidence"), evidence.evidencePath);
	assert(relativeEvidence && !isAbsolute(relativeEvidence) && !relativeEvidence.startsWith(".."), "能力证据超出本实例归属。");
	assert((await lstat(evidence.evidencePath)).isFile(), "能力证据不是普通文件。");
	const currentEvidence = await readOptionalJson(evidence.evidencePath);
	assert(currentEvidence?.status === "supported" && currentEvidence.probeProtocolRevision === 1, "当前二进制尚无成功的隔离能力证据。");
	assert(currentEvidence.nativeExecutableIdentityDigest === evidence.nativeExecutableIdentityDigest && currentEvidence.nativeExecutableRealPath === evidence.nativeExecutableRealPath, "能力证据的原生程序归属不符。");
	const executable = await lstat(evidence.nativeExecutableRealPath, { bigint: true });
	assert.equal(digest([evidence.nativeExecutableRealPath, String(executable.dev), String(executable.ino), String(executable.size), String(executable.mtimeNs)]), evidence.nativeExecutableIdentityDigest, "实际 Codex 文件已变化，等待新能力证据。");
	assert.equal(await realpath(join(binding.configurationHomeDirectoryPath, "plugins")), shared.pluginsDirectoryCanonicalPath, "会话未采用共同插件目录。");
	assert.equal(await realpath(join(binding.configurationHomeDirectoryPath, ".tmp", "marketplaces")), shared.marketplaceInstallationDirectoryCanonicalPath, "会话未采用共同安装记录。");
	assert((await lstat(join(binding.configurationHomeDirectoryPath, ".tmp"))).isDirectory(), "会话 .tmp 归属异常。");
	const configuration = parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"));
	const confirmedTrust = [];
	const installedSnapshots = new Map();
	for (const [key, state] of Object.entries(configuration.hooks?.state || {})) {
		const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(key);
		if (!match || typeof state !== "object" || state === null || state.enabled === false || typeof state.trusted_hash !== "string" || typeof state.trusted_content_hash !== "string") continue;
		const cache = join(shared.pluginsDirectoryCanonicalPath, "cache", match[2], match[1]);
		const versions = (await readdir(cache, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".") && entry.isDirectory());
		assert(versions.length === 1, "插件安装版本有歧义，等待原生来源稳定。");
		const installedPath = await realpath(join(cache, versions[0].name));
		assert.equal(dirname(installedPath), await realpath(cache), "插件安装路径超出来源归属。");
		if (!installedSnapshots.has(installedPath)) installedSnapshots.set(installedPath, await installedPluginContentSnapshot(installedPath));
		confirmedTrust.push({ key, definitionHash: state.trusted_hash, contentHash: state.trusted_content_hash, installedPath, installationSnapshot: installedSnapshots.get(installedPath) });
	}
	if (!confirmedTrust.length) return null;
	return {
		writerId: binding.writerId, writerCreatedAtMs: binding.createdAt, sourceIdentity: binding.sourceIdentity,
		profileId: binding.codexConfigurationProfileId, nativeExecutableIdentityDigest: evidence.nativeExecutableIdentityDigest,
		confirmedTrust: confirmedTrust.sort((left, right) => left.key.localeCompare(right.key)),
	};
}

async function verifyNaturalWriterTrustContinuity() {
	const host = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
	const port = Number(process.env.KANBAN_RUNTIME_PORT || "3484");
	const scheme = process.env.KANBAN_RUNTIME_HTTPS === "1" ? "https" : "http";
	const response = await fetch(`${scheme}://${host}:${port}/api/trpc/runtime.getAgentSessionPtyHostDiagnostics`, { signal: AbortSignal.timeout(8000) });
	assert(response.ok, "无法读取目标运行实例归属。");
	const runtime = (await response.json()).result?.data;
	assert(runtime?.runtimeProcessStatus === "running" && runtime.runtimeIdentity?.runtimePort === port, "运行实例身份或端口不符。");
	const runtimeHome = await realpath(runtime.runtimeIdentity.runtimeHomeDirectoryPath);
	const heartbeatPaths = (await readdir(join(runtimeHome, "runtime-process-instance-heartbeats"))).filter((name) => name.endsWith(".json"));
	const heartbeats = await Promise.all(heartbeatPaths.map((name) => readOptionalJson(join(runtimeHome, "runtime-process-instance-heartbeats", name))));
	const heartbeat = heartbeats.find((value) => value?.pid === runtime.runtimeProcessId && Date.now() - value.lastHeartbeatAtEpochMs < 120000);
	assert(heartbeat, "目标实例的新鲜心跳不可核验，保留待验。");
	const owned = new Set((runtime.runtimePtySessions || []).map((session) => JSON.stringify([session.workspaceId, session.conversationSessionId, session.runtimeSessionIncarnationId])));
	const writersRoot = join(runtimeHome, "codex-configuration-writer-bindings-and-sync", "writers");
	const bindings = [];
	for (const directory of await readdir(writersRoot)) {
		if (!/^[a-f0-9-]{36}$/.test(directory)) continue;
		const binding = await readOptionalJson(join(writersRoot, directory, "writer-binding.json"));
		if (binding?.purpose === "native_session" && binding.createdAt >= heartbeat.startedAtEpochMs && owned.has(JSON.stringify([binding.workspaceId, binding.conversationSessionId, binding.runtimeSessionIncarnationId]))) bindings.push(binding);
	}
	const baseline = await readOptionalJson(baselinePath);
	const matchesBaselineScope = (binding) => baseline && baseline.runtimeProcessId === runtime.runtimeProcessId && baseline.sourceIdentity === binding.sourceIdentity && baseline.profileId === binding.codexConfigurationProfileId && baseline.nativeExecutableIdentityDigest === binding.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence.nativeExecutableIdentityDigest;
	bindings.sort((left, right) => Number(Boolean(matchesBaselineScope(right))) - Number(Boolean(matchesBaselineScope(left))) || right.createdAt - left.createdAt);
	let observed;
	for (const binding of bindings) {
		observed = await qualifiedWriterSnapshot(binding, runtimeHome);
		if (observed) break;
	}
	assert(observed, "尚未观察到本代实例的新会话采用自动能力核验并保存插件内容信任，等待自然启动后重验。");
	const sameScope = baseline && baseline.runtimeProcessId === runtime.runtimeProcessId && baseline.sourceIdentity === observed.sourceIdentity && baseline.profileId === observed.profileId && baseline.nativeExecutableIdentityDigest === observed.nativeExecutableIdentityDigest;
	const trustIdentity = (snapshot) => snapshot.confirmedTrust.map(({ key, definitionHash, contentHash }) => ({ key, definitionHash, contentHash }));
	if (!sameScope || digest(trustIdentity(baseline)) !== digest(trustIdentity(observed))) {
		await appendFile(journalPath, `${JSON.stringify({ observedAtMs: Date.now(), event: "observation_baseline_replaced", previousBaseline: baseline, nextObservedSnapshot: observed })}\n`, { mode: 0o600 });
		await writeFile(baselinePath, JSON.stringify({ ...observed, runtimeProcessId: runtime.runtimeProcessId, observedAtMs: Date.now() }, null, 2), { mode: 0o600 });
		throw new Error("已保存新能力或新确认的观察基线；等待之后另一个自然启动的会话，旧观察保留在追加日志中。");
	}
	assert(observed.writerId !== baseline.writerId && observed.writerCreatedAtMs > baseline.observedAtMs, "等待基线之后自然创建的下一代会话，不启动或重启用户任务。");
	assert.equal(digest(observed.confirmedTrust), digest(baseline.confirmedTrust), "相同批准的插件安装内容或目录发生变化；保留失败与原基线，等待核验。");
	return { ok: true, previousWriterId: baseline.writerId, observedWriterId: observed.writerId, observation: "真实新会话采用共享安装能力；同内容的插件批准与安装目录跨自然启动保持稳定。" };
}

verifyNaturalWriterTrustContinuity().then(async (result) => {
	await appendFile(journalPath, `${JSON.stringify({ observedAtMs: Date.now(), ...result })}\n`, { mode: 0o600 });
	console.log(JSON.stringify(result));
}).catch(async (error) => {
	const result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
	await appendFile(journalPath, `${JSON.stringify({ observedAtMs: Date.now(), ...result })}\n`, { mode: 0o600 });
	console.error(JSON.stringify(result));
	process.exitCode = 1;
});
