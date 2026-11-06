// 仅隔离性能夹具加载；计数不保存文件正文，Profiler 通过父进程 IPC 控制。
if (require("node:worker_threads").isMainThread) {
	const fs = require("node:fs/promises");
	const { syncBuiltinESMExports } = require("node:module");
	const { monitorEventLoopDelay } = require("node:perf_hooks");
	const inspector = require("node:inspector");
	const session = new inspector.Session();
	session.connect();
	const post = (method) => new Promise((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve(result)));
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	let enabled = false;
	let bytesRead = 0;
	let bytesWritten = 0;
	let readCalls = 0;
	let writeCalls = 0;
	let cpuBefore = process.cpuUsage();
	let resourceBefore = process.resourceUsage();
	let profiled = false;
	let childProcessesStarted = 0;
	let peakTrackedChildProcessCount = 0;
	const trackedChildProcessIds = new Set();
	const gitProbeConcurrencyWaitChannel = require("node:diagnostics_channel").channel("cline-kanban.workspace-context-git-probe-concurrency-wait");
	let gitProbeQueueWaits = [];
	const observeGitProbeQueueWait = (message) => { if (enabled) gitProbeQueueWaits.push(message.waitDurationMs); };
	const childProcess = require("node:child_process");
	const { promisify } = require("node:util");
	const trackChildProcess = (child) => {
		if (typeof child?.pid !== "number" || trackedChildProcessIds.has(child.pid)) return;
		trackedChildProcessIds.add(child.pid);
		if (enabled) { childProcessesStarted += 1; peakTrackedChildProcessCount = Math.max(peakTrackedChildProcessCount, trackedChildProcessIds.size); }
		child.once("exit", () => trackedChildProcessIds.delete(child.pid));
		child.once("error", () => trackedChildProcessIds.delete(child.pid));
	};
	for (const operation of ["spawn", "fork", "execFile"]) {
		const original = childProcess[operation];
		const wrapped = function (...args) {
			const child = original.apply(this, args);
			trackChildProcess(child);
			return child;
		};
		if (original[promisify.custom]) wrapped[promisify.custom] = function (...args) {
			const result = original[promisify.custom].apply(this, args);
			trackChildProcess(result.child);
			return result;
		};
		childProcess[operation] = wrapped;
	}
	for (const operation of ["spawnSync", "execFileSync", "execSync"]) {
		const original = childProcess[operation];
		childProcess[operation] = function (...args) {
			const observe = enabled;
			const result = original.apply(this, args);
			if (observe && (operation !== "spawnSync" || typeof result.pid === "number")) {
				childProcessesStarted += 1;
				peakTrackedChildProcessCount = Math.max(peakTrackedChildProcessCount, trackedChildProcessIds.size + 1);
			}
			return result;
		};
	}
	const originalWriteFile = fs.writeFile.bind(fs);
	for (const operation of ["readFile", "writeFile", "appendFile"]) {
		const original = fs[operation];
		fs[operation] = function (...args) {
			const result = original.apply(this, args);
			if (!enabled) return result;
			return result.then((value) => {
				if (operation === "readFile") {
					readCalls += 1;
					bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
				} else {
					writeCalls += 1;
					const input = args[1];
					if (typeof input === "string" || Buffer.isBuffer(input)) bytesWritten += Buffer.byteLength(input);
				}
				return value;
			});
		};
	}
	syncBuiltinESMExports();
	process.on("message", async (message) => {
		if (!message || message.kind !== "high_load_fixture_metrics") return;
		try {
			if (message.operation === "begin") {
				bytesRead = bytesWritten = readCalls = writeCalls = 0;
				childProcessesStarted = 0;
				gitProbeQueueWaits = [];
				peakTrackedChildProcessCount = trackedChildProcessIds.size;
				enabled = message.instrumentationEnabled;
				gitProbeConcurrencyWaitChannel.unsubscribe(observeGitProbeQueueWait);
				if (enabled) gitProbeConcurrencyWaitChannel.subscribe(observeGitProbeQueueWait);
				profiled = message.profileEnabled;
				if (profiled) { await post("Profiler.enable"); await post("Profiler.start"); }
				histogram.reset();
				if (enabled) histogram.enable();
				cpuBefore = process.cpuUsage();
				resourceBefore = process.resourceUsage();
				process.send?.({ id: message.id, ok: true });
			} else if (message.operation === "finish") {
				const cpu = process.cpuUsage(cpuBefore);
				const resource = process.resourceUsage();
				gitProbeQueueWaits.sort((a, b) => a - b);
				const metrics = {
					cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
					workspaceContextGitProbeQueueWaitSampleCount: gitProbeQueueWaits.length,
					workspaceContextGitProbeQueueWaitP95Ms: gitProbeQueueWaits[Math.ceil(gitProbeQueueWaits.length * 0.95) - 1] ?? null,
					workspaceContextGitProbeQueueWaitMaxMs: gitProbeQueueWaits.at(-1) ?? null,
					trackedChildProcessesStarted: childProcessesStarted, peakTrackedChildProcessCount, remainingTrackedChildProcessCount: trackedChildProcessIds.size,
					rssBytes: process.memoryUsage().rss,
					eventLoopSampleCount: Number(histogram.count),
					eventLoopP99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
					eventLoopMaxMs: histogram.max / 1e6,
					mainThreadObservedReadBytes: bytesRead, mainThreadObservedWriteBytes: bytesWritten,
					mainThreadObservedReadCalls: readCalls, mainThreadObservedWriteCalls: writeCalls,
					nativeFileSystemReadOperations: resource.fsRead - resourceBefore.fsRead,
					nativeFileSystemWriteOperations: resource.fsWrite - resourceBefore.fsWrite,
				};
				enabled = false;
				gitProbeConcurrencyWaitChannel.unsubscribe(observeGitProbeQueueWait);
				histogram.disable();
				if (profiled) {
					const result = await post("Profiler.stop");
					await originalWriteFile(message.profilePath, JSON.stringify(result.profile));
				}
				process.send?.({ id: message.id, ok: true, metrics });
			}
		} catch (error) { process.send?.({ id: message.id, ok: false, error: String(error) }); }
	});
}
