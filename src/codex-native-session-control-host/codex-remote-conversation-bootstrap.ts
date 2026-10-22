import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CodexAppServerRequestPort } from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import {
	buildCodexRemoteConversationResumeTuiArguments,
	type CodexRemoteConversationLaunchPlan,
	codexNativeApprovalPolicySchema,
} from "./codex-remote-conversation-launch-plan";

const nativeConversationResponseSchema = z.object({
	thread: z.object({ id: z.string().min(1), path: z.string().nullable().optional(), cwd: z.string().min(1) }),
	approvalPolicy: codexNativeApprovalPolicySchema,
	sandbox: z.looseObject({ type: z.string(), writableRoots: z.array(z.string()).optional() }),
	approvalsReviewer: z.string().optional(),
});
type NativeConversationResponse = z.infer<typeof nativeConversationResponseSchema>;

const nativeSandboxTypeByMode = {
	"read-only": "readOnly",
	"workspace-write": "workspaceWrite",
	"danger-full-access": "dangerFullAccess",
} as const;

async function canonicalPath(path: string) {
	return realpath(path).catch(() => resolve(path));
}

async function selectSourceNativeSessionId(port: CodexAppServerRequestPort, plan: CodexRemoteConversationLaunchPlan) {
	if (plan.sourceNativeSessionId) return plan.sourceNativeSessionId;
	const configuration = z
		.object({ config: z.looseObject({ model_provider: z.string().nullish() }) })
		.parse(await port.request("config/read", { includeLayers: false, cwd: plan.workingDirectoryPath }));
	const parameters = {
		limit: 1,
		sortKey: "updated_at",
		sortDirection: "desc",
		archived: false,
		cwd: plan.selectsAcrossWorkingDirectories ? null : plan.workingDirectoryPath,
		modelProviders: [configuration.config.model_provider ?? "openai"],
		sourceKinds: plan.includeNonInteractiveConversations ? ["cli", "vscode", "exec", "appServer"] : ["cli", "vscode"],
	};
	const pageSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
	// 与原生 --last 一致：先查 DB，无命中再允许原生扫描修复索引，不自行扫描历史猜身份。
	let page = pageSchema.parse(await port.request("thread/list", { ...parameters, useStateDbOnly: true }));
	if (!page.data.length) page = pageSchema.parse(await port.request("thread/list", parameters));
	const selected = page.data[0];
	if (!selected) throw new Error("当前恢复范围内没有可接续的 Codex 会话，未创建空会话。");
	return selected.id;
}

async function matchesRequestedPermissions(
	response: NativeConversationResponse,
	plan: CodexRemoteConversationLaunchPlan,
) {
	const requested = plan.nativeThreadRequestOverrides;
	if (requested.approvalPolicy !== undefined && !isDeepStrictEqual(response.approvalPolicy, requested.approvalPolicy))
		return false;
	if (requested.sandbox !== undefined && response.sandbox.type !== nativeSandboxTypeByMode[requested.sandbox])
		return false;
	if (requested.approvalsReviewer !== undefined && response.approvalsReviewer !== requested.approvalsReviewer)
		return false;
	if (response.sandbox.type === "workspaceWrite" && plan.additionalWritableDirectoryPaths.length) {
		const actual = await Promise.all((response.sandbox.writableRoots ?? []).map(canonicalPath));
		for (const path of plan.additionalWritableDirectoryPaths)
			if (!actual.includes(await canonicalPath(path))) return false;
	}
	return true;
}

function requestedSandboxPolicy(response: NativeConversationResponse, plan: CodexRemoteConversationLaunchPlan) {
	const mode = plan.nativeThreadRequestOverrides.sandbox;
	const type = mode ? nativeSandboxTypeByMode[mode] : response.sandbox.type;
	if (type === "dangerFullAccess") return { type };
	if (type === "readOnly") return { type, networkAccess: false };
	if (type === "workspaceWrite")
		return {
			...response.sandbox,
			type,
			writableRoots: [
				...new Set([
					plan.workingDirectoryPath,
					...(response.sandbox.writableRoots ?? []),
					...plan.additionalWritableDirectoryPaths,
				]),
			],
			networkAccess: response.sandbox.networkAccess === true,
			excludeTmpdirEnvVar: response.sandbox.excludeTmpdirEnvVar === true,
			excludeSlashTmp: response.sandbox.excludeSlashTmp === true,
		};
	throw new Error("原生宿主返回无法核对的沙箱权限类型。");
}

export interface CodexRemoteConversationBootstrapReceipt {
	nativeSessionId: string;
	nativeTranscriptPath: string | null;
	effectiveApprovalPolicy: NativeConversationResponse["approvalPolicy"];
	effectiveSandbox: NativeConversationResponse["sandbox"];
	tuiArguments: string[];
}

export async function bootstrapCodexRemoteConversationBeforeTuiAttach(
	port: CodexAppServerRequestPort,
	plan: CodexRemoteConversationLaunchPlan,
): Promise<CodexRemoteConversationBootstrapReceipt> {
	const sourceNativeSessionId = await selectSourceNativeSessionId(port, plan);
	const overrides = plan.nativeThreadRequestOverrides;
	const config = { ...overrides.config };
	if (plan.additionalWritableDirectoryPaths.length) {
		const roots = config["sandbox_workspace_write.writable_roots"];
		config["sandbox_workspace_write.writable_roots"] = [
			...(Array.isArray(roots) ? z.array(z.string()).parse(roots) : []),
			...plan.additionalWritableDirectoryPaths,
		];
	}
	const parameters = {
		threadId: sourceNativeSessionId,
		cwd: plan.workingDirectoryPath,
		excludeTurns: true,
		...(plan.operation === "fork" ? { deferGoalContinuation: true } : {}),
		...overrides,
		...(Object.keys(config).length ? { config } : {}),
	};
	// 首次装载就携带限制，不能让只读 fork 在高权限状态下接收正文。非幂等 fork 不重试。
	let response = nativeConversationResponseSchema.parse(await port.request(`thread/${plan.operation}`, parameters));
	const nativeSessionId = response.thread.id;
	if (
		plan.operation === "resume"
			? nativeSessionId !== sourceNativeSessionId
			: nativeSessionId === sourceNativeSessionId
	) {
		throw new Error("Codex 返回了错误的恢复或分叉身份，未启动 TUI。");
	}
	if ((await canonicalPath(response.thread.cwd)) !== (await canonicalPath(plan.workingDirectoryPath))) {
		throw new Error("Codex 返回的恢复工作目录与本次启动不一致。");
	}
	if (!(await matchesRequestedPermissions(response, plan))) {
		// 已加载 thread 的 resume 可能只做重新订阅，忽略覆盖；必须显式更新，再读回实际值。
		await port.request("thread/settings/update", {
			threadId: nativeSessionId,
			...(overrides.approvalPolicy !== undefined ? { approvalPolicy: overrides.approvalPolicy } : {}),
			...(overrides.approvalsReviewer !== undefined ? { approvalsReviewer: overrides.approvalsReviewer } : {}),
			sandboxPolicy: requestedSandboxPolicy(response, plan),
		});
		response = nativeConversationResponseSchema.parse(
			await port.request("thread/resume", { threadId: nativeSessionId, excludeTurns: true }),
		);
		if (
			response.thread.id !== nativeSessionId ||
			(await canonicalPath(response.thread.cwd)) !== (await canonicalPath(plan.workingDirectoryPath)) ||
			!(await matchesRequestedPermissions(response, plan))
		) {
			throw new Error("Codex 有效权限与任务要求不一致，未启动 TUI 或投递正文。");
		}
	}
	return {
		nativeSessionId,
		nativeTranscriptPath: response.thread.path ?? null,
		effectiveApprovalPolicy: response.approvalPolicy,
		effectiveSandbox: response.sandbox,
		tuiArguments: buildCodexRemoteConversationResumeTuiArguments(plan, nativeSessionId),
	};
}
