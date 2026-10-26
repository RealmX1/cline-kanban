// 部署后只读观测：不生成用户输入、任务或负载。复制到 PDV assetsDir 后可独立运行。
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function verifyNaturalRuntimeCostWindows() {
	const host = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
	const port = process.env.KANBAN_RUNTIME_PORT || "3484";
	const runtimeHome = join(homedir(), ".cline", "kanban");
	const journalDirectory = process.env.KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR || join(runtimeHome, "diagnostic-event-journals");
	const shardNames = (await readdir(journalDirectory)).filter((name) => /^daily-work-progress-collection-cost-window-sample(?:\.\d+)?\.jsonl$/u.test(name));
	const candidatesByInstance = new Map();
	for (const name of shardNames) {
		let text;
		try { text = await readFile(join(journalDirectory, name), "utf8"); }
		catch (error) { if (error.code === "ENOENT") continue; throw error; }
		for (const line of text.split("\n").filter(Boolean)) {
			let window;
			try { window = JSON.parse(line); } catch { continue; }
			const identity = window.runtimeIdentity;
			if (window.schemaVersion !== "daily-work-progress-collection-cost-window/v1" || !identity || window.flushReason !== "interval" || window.windowDurationMs < 59_000) continue;
			const origin = new URL(identity.runtimeOrigin);
			const normalHost = (value) => value === "localhost" ? "127.0.0.1" : value;
			if (normalHost(origin.hostname) !== normalHost(host) || (origin.port || (origin.protocol === "https:" ? "443" : "80")) !== String(port)) continue;
			if (Date.now() - Date.parse(window.recordedAtIso) > 5 * 60_000) continue;
			let heartbeat;
			try { heartbeat = JSON.parse(await readFile(join(runtimeHome, "runtime-process-instance-heartbeats", `${identity.runtimeProcessInstanceId}.json`), "utf8")); }
			catch { continue; }
			if (heartbeat.runtimeProcessInstanceId !== identity.runtimeProcessInstanceId || heartbeat.pid !== window.journalWriterProcessId || Date.now() - heartbeat.lastHeartbeatAtEpochMs > 120_000 || window.windowStartedAtEpochMs < heartbeat.startedAtEpochMs) continue;
			if (!(window.stages?.refresh?.calls > 0) || !(window.stages?.statistics_read?.readOperations > 0)) continue;
			for (const cost of Object.values(window.stages)) {
				if (!Object.values(cost).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("成本窗口存在非数值阶段内容");
			}
			if (!Object.values(window.counters).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("成本窗口存在非数值计数内容");
			const key = `${identity.runtimeProcessInstanceId}:${window.collectorInstanceId}:${window.journalWriterProcessStartedAtIso}`;
			const existing = candidatesByInstance.get(key) || [];
			existing.push(window); candidatesByInstance.set(key, existing);
		}
	}
	const windows = [...candidatesByInstance.values()].find((records) => new Set(records.map((record) => record.windowStartedAtEpochMs)).size >= 2);
	if (!windows) throw new Error("尚无目标实例两个完整的 60 秒成本窗口；部署后保持刻度开启，待自然采集产生新窗口后重验");
	const latest = windows.sort((a, b) => b.windowStartedAtEpochMs - a.windowStartedAtEpochMs)[0];
	const response = await fetch(`${latest.runtimeIdentity.runtimeOrigin}/api/passcode/status`, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) throw new Error(`目标运行实例只读请求失败：${response.status}`);
	process.stdout.write(`${JSON.stringify({ conclusion: "通过：真实常驻采集产生了归属一致且不含正文的成本窗口", runtimeIdentity: latest.runtimeIdentity, collectorInstanceId: latest.collectorInstanceId, verifiedWindowCount: windows.length })}\n`);
}
verifyNaturalRuntimeCostWindows().catch((error) => {
	process.stderr.write(`暂未通过今日进展成本窗口验证：${error.message}\n`);
	process.exitCode = 1;
});
