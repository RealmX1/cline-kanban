// exploration thread graph 的 store 根目录解析（B.2 宿主胶水）。
//
// 图本身不由本仓库建模——领域 schema / store / 漏斗全在独立包
// agent-conversation-exploration-thread-graph 里（见 docs/exploratory-mode-host-integration.md）。
// 本仓库只负责回答一个问题：**这个 workspace 的图该落在磁盘的哪里**，然后把该路径作为
// `storeRoot` 传给核心包，由它自己读写。
//
// 位置选在 workspace 目录下的独立子目录（与 board.json / sessions.json / exploratory-findings.json
// 同级的一个目录），而不是单个文件：核心包在 storeRoot 下自己铺三样东西——
//   - `topic-registry.json`（**整个 storeRoot 共享**，不按 exploration 分）
//   - `explorations/<explorationId>/exploration-thread-graph.json`
//   - `exploration-thread-graph-store-write.lock`（跨进程写锁）
// 所以它必须独占一个目录，不能与宿主自己的文件混放。
//
// 锁文件那条尤其要记住：**宿主的备份 / 体检 / 清理逻辑必须放过它，且绝不删除活动锁**
// （核心包有 15s 陈旧回收，误删会让并发写丢失）。要判断某个路径是不是锁，一律用核心包导出的
// `resolveExplorationThreadGraphStoreWriteLockPath(storeRoot)`，别自己拼字符串。

import { dirname, join, resolve } from "node:path";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";

// workspace 目录下的子目录名。与包名同名是有意的：磁盘上一眼看得出这份数据归谁管、由哪个包的
// schema 版本负责迁移。
const EXPLORATION_THREAD_GRAPH_STORE_DIRECTORY_NAME = "agent-conversation-exploration-thread-graph";

/**
 * 解析某 workspace 的 exploration thread graph `storeRoot`。
 *
 * 防路径遍历守卫与 exploratory-findings-store 同款（workspace 目录必须是 workspaces 根的直接
 * 子目录）：本函数的调用链最终能经 tRPC 从客户端 input 拿到 workspaceId，这条守卫是必需的、
 * 不是形式主义。
 */
export function resolveWorkspaceExplorationThreadGraphStoreRoot(workspaceId: string): string {
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing exploration thread graph store access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, EXPLORATION_THREAD_GRAPH_STORE_DIRECTORY_NAME);
}
