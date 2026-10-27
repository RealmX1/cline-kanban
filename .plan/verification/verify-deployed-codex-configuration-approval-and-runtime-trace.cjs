const { readFile, readdir } = require("node:fs/promises");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

async function verifyDeployedCodexConfigurationApprovalAndRuntimeTrace() {
	const host = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
	const port = process.env.KANBAN_RUNTIME_PORT || "3484";
	const scheme = process.env.KANBAN_RUNTIME_HTTPS === "1" ? "https" : "http";
	const origin = `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
	const response = await fetch(origin, { signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(`真实运行时不可达：HTTP ${response.status}`);
	const runtimeHome = join(homedir(), ".cline", "kanban");
	const state = JSON.parse(await readFile(join(runtimeHome, "codex-configuration-writer-bindings-and-sync", "configuration-sync-state.json"), "utf8"));
	if (state.schemaVersion !== 2) throw new Error("真实运行时尚未采用配置审批 schemaVersion 2，等待本次实现部署并完成启动扫描。");
	const changes = Array.isArray(state.changes) ? state.changes : [];
	if (changes.some((change) => change.approvalStatus === "pending" && change.mergeStatus === "shared_default_updated")) throw new Error("存在尚未审批却标为已采用默认的设置。");
	if (changes.some((change) => change.previous && change.value && isDeepStrictEqual(change.previous.value, change.value.value) && change.previous.definitionDigest !== change.value.definitionDigest && change.recordKind !== "source_observation")) throw new Error("有来源摘要变化被错误归类为设置提案。");
	const headers = process.env.KANBAN_INTERNAL_AUTH_TOKEN
		? { Authorization: `Bearer ${process.env.KANBAN_INTERNAL_AUTH_TOKEN}` }
		: {};
	const liveStateResponse = await fetch(`${origin}/api/trpc/runtime.getCodexConfigurationSyncState`, {
		headers,
		signal: AbortSignal.timeout(5000),
	});
	if (!liveStateResponse.ok) throw new Error(`真实运行时配置状态不可读：HTTP ${liveStateResponse.status}`);
	const liveState = (await liveStateResponse.json()).result?.data;
	if (liveState?.diagnosticCoverage?.fileObservation !== "active" || liveState.diagnosticCoverage.targetCount < 1)
		throw new Error("当前运行实例的只读采集尚未就绪；稍后按相同入口重验。");
	const journalDirectory = join(runtimeHome, "diagnostic-event-journals");
	const channel = "codex-configuration-and-plugin-cache-initiator-trace";
	const names = (await readdir(journalDirectory)).filter((name) => name === `${channel}.jsonl` || new RegExp(`^${channel}\\.\\d+\\.jsonl$`).test(name)).slice(0, 5);
	let observedStartupSnapshot = false;
	for (const name of names) {
		const lines = (await readFile(join(journalDirectory, name), "utf8")).split("\n");
		for (const line of lines) {
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.channel === channel && event.event === "initial_target_snapshot" && event.actualWriter === "unknown" && event.monitorIncarnationId && event.currentSnapshot) observedStartupSnapshot = true;
		}
	}
	if (!observedStartupSnapshot) throw new Error("尚未找到真实运行时启动的基础采集快照；等待运行时完成启动采集后重试，系统写入者仍保持未知。");
	process.stdout.write(`通过：真实运行时已采用审批迁移，原始记录 ${changes.length} 条，来源观测 ${state.sourceObservations?.length ?? 0} 条；基础采集已启动。此检查不证明系统级实际写入者或浏览器视觉验收通过。\n`);
}

verifyDeployedCodexConfigurationApprovalAndRuntimeTrace().catch((error) => {
	process.stderr.write(`待验：${error.message}\n`);
	process.exitCode = 1;
});
