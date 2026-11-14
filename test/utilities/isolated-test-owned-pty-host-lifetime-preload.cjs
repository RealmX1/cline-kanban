// NODE_OPTIONS 随 runtime 的 daemonize 继承；只在测试拥有的真实 PTY host 主程序之前登记。
const leasePath = process.env.CLINE_KANBAN_TEST_PTY_LIFETIME_LEASE_PATH;
const hostEntry = process.argv[1] || "";
if (leasePath && /(?:agent-session-pty-host-process-entry\.ts|agent-session-pty-host\.js)$/.test(hostEntry)) {
	try {
		const fs = require("node:fs");
		const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
		if (lease.closed) process.exit(1);
		if (!process.argv.includes("--daemonize")) {
			require("tsx/cjs");
			require("./isolated-test-owned-pty-host-lifetime.ts").startTestOwnedPtyHostLifetimeWatcher(leasePath);
		}
	} catch (error) {
		process.stderr.write(`测试 PTY 所有权登记失败，拒绝启动: ${String(error)}\n`);
		process.exit(1);
	}
}
