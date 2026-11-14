import { reclaimTestOwnedPtyHostLifetime } from "./isolated-test-owned-pty-host-lifetime";

const leasePath = process.argv[2];
if (!leasePath) throw new Error("测试 PTY 回收必须绑定持久 lease 路径");
void reclaimTestOwnedPtyHostLifetime(leasePath).then(
	(completed) => {
		process.exitCode = completed ? 0 : 1;
	},
	(error: unknown) => {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	},
);
