// 建卡时「从哪个 ref 拉任务 worktree」的**唯一**解析规则。
//
// 分出这个模块的理由：这条规则此前有三份互相矛盾的实现——Web 建卡对话框硬偏好字面量 "main"、
// CLI `task create` 与 Web 快速添加各自就地写了「currentBranch 优先」。同一个项目换条入口建卡就
// 落到不同的 base 上，而这个差异在卡片建出来之前对任何人都不可见。
//
// 两处与旧行为不同、且是有意为之的：
//
//   1. 不再硬偏好字面量 "main"。默认分支该由 detectGitDefaultBranch（origin/HEAD → main → master →
//      第一个）解析；写死 "main" 会对「默认分支叫别的名字、但恰好也存在一条 main」的仓库说谎。
//   2. defaultBranch 排在 currentBranch **之前**。任务 worktree 的正确基线是仓库的集成分支，不是
//      主 checkout 此刻恰好停在哪儿；旧的 currentBranch 优先会让「用户切到某分支看了眼代码」直接
//      污染随后建的每一张卡。人若确实想基于当前分支建卡，那是一次显式选择（见 explicitly_requested），
//      而显式选择会被记住（见 rememberedBaseRefForProject）。
import type { RuntimeGitRepositoryInfo } from "./api-contract";

/** 解析出的 base ref 究竟来自哪一条规则。用于 UI 提示与 CLI 预览里的告警派生。 */
export type TaskCreateBaseRefProvenance =
	/** 调用方这次显式指定的（CLI `--base-ref`，或对话框里当次选定的下拉项）。 */
	| "explicitly_requested"
	/** 该项目上一次成功建卡所用的 ref，由跨 origin 界面偏好记住。 */
	| "remembered_project_selection"
	/** 仓库默认分支（detectGitDefaultBranch 的结果）。 */
	| "repository_default_branch"
	/** 主 checkout 当前所在分支。 */
	| "repository_current_branch"
	/** 分支列表里的第一条——上面全都取不到时的兜底。 */
	| "first_known_branch";

export interface TaskCreateBaseRefResolution {
	/** 解析结果。一条分支都识别不出来时为空串，由调用方决定是报错还是继续。 */
	baseRef: string;
	/** baseRef 为空串时为 null。 */
	provenance: TaskCreateBaseRefProvenance | null;
	/**
	 * 记忆值指向的分支已不存在于仓库、因而被丢弃时，记下那个失效的名字。
	 *
	 * 单独留一个字段而不是让调用方自己比对：分支被删除后静默回落到默认分支是对的行为，但「静默」
	 * 本身要能被 CLI 预览与 UI 说出来，否则用户只会看到 base ref 莫名其妙变了。
	 */
	rememberedBaseRefDiscardedBecauseBranchNoLongerExists: string | null;
}

export interface TaskCreateBaseRefResolutionInput {
	/** CLI `--base-ref` / 对话框当次选定值。空串与空白视同未指定。 */
	explicitlyRequestedBaseRef?: string | null;
	/** 该项目上次成功建卡用的 ref。仅当它仍存在于 repository.branches 时才会被采纳。 */
	rememberedBaseRefForProject?: string | null;
	repository: Pick<RuntimeGitRepositoryInfo, "currentBranch" | "defaultBranch" | "branches">;
}

function normalizeRefName(value: string | null | undefined): string {
	return (value ?? "").trim();
}

/**
 * 记忆值必须先验证仍然存在。
 *
 * 显式值刻意**不**做这个校验：调用方明说了要哪个 ref，就该原样用它并让下游 git 操作在真的不存在时
 * 如实失败——把用户/agent 的显式意图悄悄换成别的分支比报错危险得多。记忆值则相反，它是本模块自己
 * 从历史里翻出来的，用户没有在这一刻表达任何意图，因此失效时回落才是符合预期的。
 */
function doesBranchStillExistInRepository(
	branchName: string,
	repository: TaskCreateBaseRefResolutionInput["repository"],
): boolean {
	return repository.branches.some((branch) => branch.name.trim() === branchName);
}

export function resolveTaskCreateBaseRef(input: TaskCreateBaseRefResolutionInput): TaskCreateBaseRefResolution {
	const { repository } = input;

	const explicitlyRequestedBaseRef = normalizeRefName(input.explicitlyRequestedBaseRef);
	if (explicitlyRequestedBaseRef) {
		return {
			baseRef: explicitlyRequestedBaseRef,
			provenance: "explicitly_requested",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		};
	}

	const rememberedBaseRefForProject = normalizeRefName(input.rememberedBaseRefForProject);
	const rememberedBaseRefDiscardedBecauseBranchNoLongerExists =
		rememberedBaseRefForProject && !doesBranchStillExistInRepository(rememberedBaseRefForProject, repository)
			? rememberedBaseRefForProject
			: null;
	if (rememberedBaseRefForProject && !rememberedBaseRefDiscardedBecauseBranchNoLongerExists) {
		return {
			baseRef: rememberedBaseRefForProject,
			provenance: "remembered_project_selection",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		};
	}

	const fallbackCandidates: readonly { baseRef: string; provenance: TaskCreateBaseRefProvenance }[] = [
		{ baseRef: normalizeRefName(repository.defaultBranch), provenance: "repository_default_branch" },
		{ baseRef: normalizeRefName(repository.currentBranch), provenance: "repository_current_branch" },
		{ baseRef: normalizeRefName(repository.branches[0]?.name), provenance: "first_known_branch" },
	];
	for (const candidate of fallbackCandidates) {
		if (candidate.baseRef) {
			return {
				baseRef: candidate.baseRef,
				provenance: candidate.provenance,
				rememberedBaseRefDiscardedBecauseBranchNoLongerExists,
			};
		}
	}

	return {
		baseRef: "",
		provenance: null,
		rememberedBaseRefDiscardedBecauseBranchNoLongerExists,
	};
}

/**
 * 「若这个项目没有记忆值，本该解析成什么」——用于把「记忆值改变了结果」这件事说清楚。
 *
 * CLI 预览与 UI 提示都需要它：只说「现在用的是 feature/x」不足以让人判断要不要干预，得同时给出
 * 「不记的话会是 main」。
 */
export function resolveTaskCreateBaseRefIgnoringRememberedProjectSelection(
	repository: TaskCreateBaseRefResolutionInput["repository"],
): TaskCreateBaseRefResolution {
	return resolveTaskCreateBaseRef({ repository });
}
