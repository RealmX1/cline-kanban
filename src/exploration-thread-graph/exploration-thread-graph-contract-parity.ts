// 契约层 zod ↔ 核心包类型的**编译期双向对账**。
//
// 为什么需要这么一个文件：web-ui 不能 import 核心包（`/core` 静态导出依赖 node `fs` 的 store，
// 打进浏览器 bundle 会炸），所以 `api-contract.ts` 必须自带一份可被 `@runtime-contract` 解析的
// projection view 形状。两份形状之间没有任何自动联系——核心包换 SHA 后字段一改，契约层照旧编译通过，
// 然后在运行时以「服务端算出来的整值过不了自己的 output schema」的方式炸开。
//
// 这里用一对互相 extends 的类型断言把两者钉死：任一侧多字段、少字段、类型不符，根 `npm run typecheck`
// 立刻红，且错误就落在这个文件上——而不是落在某个看不出所以然的调用点。
//
// 这个文件**只有类型**，没有运行时代码；web-ui 不 import 它，所以核心包不会因此进浏览器 bundle。

import type { ExplorationThreadGraphProjectionView } from "agent-conversation-exploration-thread-graph/core";
import type { RuntimeExplorationThreadGraphProjectionView } from "../core/api-contract";

// 双向可赋值 ⇒ 结构等价。两侧都用元组包裹：裸类型参数在条件类型里会对联合分发，
// 那会让「一侧是联合的子集」被误判成等价。
type IsMutuallyAssignable<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

// 只接受 true。不等价时上面得到 false，这个约束当场编译报错——而不是悄悄变成 never 蒙混过去。
type AssertStructurallyEquivalent<Equivalent extends true> = Equivalent;

/**
 * 契约层的 `RuntimeExplorationThreadGraphProjectionView` 必须与核心包的
 * `ExplorationThreadGraphProjectionView` 结构等价。这一行红了就说明核心包的 SHA 换过、形状漂了——
 * 去 `api-contract.ts` 的 exploration thread graph 段落按新形状补齐，别改这里。
 */
export type ExplorationThreadGraphProjectionViewContractParity = AssertStructurallyEquivalent<
	IsMutuallyAssignable<RuntimeExplorationThreadGraphProjectionView, ExplorationThreadGraphProjectionView>
>;
