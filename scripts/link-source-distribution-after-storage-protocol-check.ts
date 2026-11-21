import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertTaskClosureStorageProtocolCompatibleWithDistribution } from "../src/task-closure/task-closure-storage-protocol-compatibility";

// npm link 的 bin 固定指向 dist；并行构建输出不能替代实际安装目录的协议核验。
// 拒绝时保留全局入口、旧安装和目标 runtime home 原件。
await assertTaskClosureStorageProtocolCompatibleWithDistribution(resolve("dist"));
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) throw new Error("缺少 npm 入口，请通过 npm run link 安装。");
const npmLinkExecutionResult = spawnSync(process.execPath, [npmCliPath, "link"], { stdio: "inherit" });
if (npmLinkExecutionResult.error) throw npmLinkExecutionResult.error;
if (npmLinkExecutionResult.status !== 0)
	throw new Error(`npm link 未完成，退出码 ${npmLinkExecutionResult.status ?? npmLinkExecutionResult.signal}。`);
