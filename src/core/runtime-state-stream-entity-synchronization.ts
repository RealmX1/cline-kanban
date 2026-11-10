import type {
	RuntimeBoardCard,
	RuntimeProjectSummary,
	RuntimeStateEntityUpdate,
	RuntimeStateStreamMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeTaskSessionSummary,
} from "./api-contract";

interface EntityCollectionPatch<Entity> {
	upserts: Entity[];
	removedKeys: string[];
	orderedKeys?: string[];
}

function buildEntityCollectionPatch<Entity>(
	previous: readonly Entity[],
	next: readonly Entity[],
	entityKey: (entity: Entity) => string,
): EntityCollectionPatch<Entity> {
	const previousByKey = new Map(previous.map((entity) => [entityKey(entity), entity]));
	const nextKeys = next.map(entityKey);
	const nextKeySet = new Set(nextKeys);
	return {
		upserts: next.filter((entity) => JSON.stringify(previousByKey.get(entityKey(entity))) !== JSON.stringify(entity)),
		removedKeys: previous.map(entityKey).filter((key) => !nextKeySet.has(key)),
		...(JSON.stringify(previous.map(entityKey)) !== JSON.stringify(nextKeys) ? { orderedKeys: nextKeys } : {}),
	};
}

function hasEntityCollectionChanges<Entity>(patch: EntityCollectionPatch<Entity>): boolean {
	return patch.upserts.length > 0 || patch.removedKeys.length > 0 || patch.orderedKeys !== undefined;
}

function applyEntityCollectionPatch<Entity>(
	previous: readonly Entity[],
	patch: EntityCollectionPatch<Entity>,
	entityKey: (entity: Entity) => string,
): Entity[] {
	const byKey = new Map(previous.map((entity) => [entityKey(entity), entity]));
	for (const key of patch.removedKeys) byKey.delete(key);
	for (const entity of patch.upserts) byKey.set(entityKey(entity), entity);
	const keys = patch.orderedKeys ?? [...byKey.keys()];
	if (new Set(keys).size !== keys.length || keys.length !== byKey.size) throw new Error("实体顺序与成员不一致");
	return keys.map((key) => {
		const entity = byKey.get(key);
		if (!entity) throw new Error(`缺少实体基线：${key}`);
		return entity;
	});
}

const taskKey = (entity: { taskId: string }) => entity.taskId;
const projectKey = (entity: { id: string }) => entity.id;
const projectBase = ({
	inProgressTaskDetails: _details,
	crossProjectTaskSwitcherEntries: _entries,
	...base
}: RuntimeProjectSummary) => base;
const boardColumns = (snapshot: RuntimeStateStreamSnapshotMessage) =>
	snapshot.workspaceState?.board.columns.map(({ cards, ...column }) => ({
		...column,
		cardIds: cards.map((card) => card.id),
	})) ?? [];
const boardCards = (snapshot: RuntimeStateStreamSnapshotMessage): RuntimeBoardCard[] =>
	snapshot.workspaceState?.board.columns.flatMap((column) => column.cards) ?? [];

export function buildRuntimeStateEntityUpdate(
	previous: RuntimeStateStreamSnapshotMessage,
	message: RuntimeStateStreamMessage,
): RuntimeStateEntityUpdate | null {
	if (message.type === "projects_updated") {
		const projects = buildEntityCollectionPatch(
			previous.projects.map(projectBase),
			message.projects.map(projectBase),
			projectKey,
		);
		const previousById = new Map(previous.projects.map((project) => [project.id, project]));
		const projectDetails = message.projects.flatMap((project) => {
			const old = previousById.get(project.id);
			const inProgressTaskDetails = buildEntityCollectionPatch(
				old?.inProgressTaskDetails ?? [],
				project.inProgressTaskDetails ?? [],
				taskKey,
			);
			const crossProjectTaskSwitcherEntries = buildEntityCollectionPatch(
				old?.crossProjectTaskSwitcherEntries ?? [],
				project.crossProjectTaskSwitcherEntries ?? [],
				taskKey,
			);
			return hasEntityCollectionChanges(inProgressTaskDetails) ||
				hasEntityCollectionChanges(crossProjectTaskSwitcherEntries)
				? [{ projectId: project.id, inProgressTaskDetails, crossProjectTaskSwitcherEntries }]
				: [];
		});
		const currentProjectId =
			previous.currentProjectId && message.projects.some((project) => project.id === previous.currentProjectId)
				? previous.currentProjectId
				: message.currentProjectId;
		return hasEntityCollectionChanges(projects) ||
			projectDetails.length > 0 ||
			previous.currentProjectId !== currentProjectId
			? { type: "projects_patch", currentProjectId, projects, projectDetails }
			: null;
	}
	if (message.type === "workspace_state_updated") {
		const next = { ...previous, workspaceState: message.workspaceState };
		const { board: _board, sessions, ...workspace } = message.workspaceState;
		const cards = buildEntityCollectionPatch(boardCards(previous), boardCards(next), projectKey);
		const columns = buildEntityCollectionPatch(boardColumns(previous), boardColumns(next), projectKey);
		const sessionChanges = buildEntityCollectionPatch(
			Object.values(previous.workspaceState?.sessions ?? {}),
			Object.values(sessions),
			taskKey,
		);
		const previousWorkspace = previous.workspaceState
			? (({ board: _previousBoard, sessions: _previousSessions, ...metadata }) => metadata)(previous.workspaceState)
			: null;
		if (
			!hasEntityCollectionChanges(cards) &&
			!hasEntityCollectionChanges(columns) &&
			!hasEntityCollectionChanges(sessionChanges) &&
			JSON.stringify(previousWorkspace) === JSON.stringify(workspace)
		)
			return null;
		return {
			type: "workspace_patch",
			workspaceId: message.workspaceId,
			workspace,
			cards,
			columns,
			sessions: sessionChanges,
		};
	}
	if (message.type === "task_sessions_updated") {
		const previousSessions = previous.workspaceState?.sessions ?? {};
		const upserts = message.summaries.filter(
			(summary) => JSON.stringify(previousSessions[summary.taskId]) !== JSON.stringify(summary),
		);
		return upserts.length > 0
			? { type: "sessions_patch", workspaceId: message.workspaceId, sessions: { upserts, removedKeys: [] } }
			: null;
	}
	if (message.type === "workspace_metadata_updated") {
		const taskWorkspaces = buildEntityCollectionPatch(
			previous.workspaceMetadata?.taskWorkspaces ?? [],
			message.workspaceMetadata.taskWorkspaces,
			taskKey,
		);
		return hasEntityCollectionChanges(taskWorkspaces) ||
			previous.workspaceMetadata?.homeGitStateVersion !== message.workspaceMetadata.homeGitStateVersion
			? {
					type: "metadata_patch",
					workspaceId: message.workspaceId,
					homeGitSummary: message.workspaceMetadata.homeGitSummary,
					homeGitStateVersion: message.workspaceMetadata.homeGitStateVersion,
					taskWorkspaces,
				}
			: null;
	}
	return null;
}

function applySessions(
	previous: Record<string, RuntimeTaskSessionSummary>,
	patch: EntityCollectionPatch<RuntimeTaskSessionSummary>,
) {
	return Object.fromEntries(
		applyEntityCollectionPatch(Object.values(previous), patch, taskKey).map((session) => [session.taskId, session]),
	);
}

export function applyRuntimeStateEntityUpdate(
	previous: RuntimeStateStreamSnapshotMessage,
	update: RuntimeStateEntityUpdate,
): RuntimeStateStreamSnapshotMessage {
	if (update.type === "projects_patch") {
		const previousById = new Map(previous.projects.map((project) => [project.id, project]));
		const detailsById = new Map(update.projectDetails.map((details) => [details.projectId, details]));
		const projects = applyEntityCollectionPatch(previous.projects.map(projectBase), update.projects, projectKey).map(
			(base) => {
				const old = previousById.get(base.id);
				const details = detailsById.get(base.id);
				return {
					...base,
					inProgressTaskDetails: details
						? applyEntityCollectionPatch(old?.inProgressTaskDetails ?? [], details.inProgressTaskDetails, taskKey)
						: (old?.inProgressTaskDetails ?? []),
					crossProjectTaskSwitcherEntries: details
						? applyEntityCollectionPatch(
								old?.crossProjectTaskSwitcherEntries ?? [],
								details.crossProjectTaskSwitcherEntries,
								taskKey,
							)
						: (old?.crossProjectTaskSwitcherEntries ?? []),
				};
			},
		);
		return { ...previous, currentProjectId: update.currentProjectId, projects };
	}
	if (update.workspaceId !== previous.currentProjectId) throw new Error("状态增量项目归属不匹配");
	if (update.type === "metadata_patch") {
		return {
			...previous,
			workspaceMetadata: {
				homeGitSummary: update.homeGitSummary,
				homeGitStateVersion: update.homeGitStateVersion,
				taskWorkspaces: applyEntityCollectionPatch(
					previous.workspaceMetadata?.taskWorkspaces ?? [],
					update.taskWorkspaces,
					taskKey,
				),
			},
		};
	}
	if (!previous.workspaceState) throw new Error("缺少工作区完整基线");
	if (update.type === "sessions_patch")
		return {
			...previous,
			workspaceState: {
				...previous.workspaceState,
				sessions: applySessions(previous.workspaceState.sessions, update.sessions),
			},
		};
	const cards = new Map(
		applyEntityCollectionPatch(boardCards(previous), update.cards, projectKey).map((card) => [card.id, card]),
	);
	const usedCardIds = new Set<string>();
	const columns = applyEntityCollectionPatch(boardColumns(previous), update.columns, projectKey).map(
		({ cardIds, ...column }) => ({
			...column,
			cards: cardIds.map((id) => {
				const card = cards.get(id);
				if (!card || usedCardIds.has(id)) throw new Error("卡片引用缺失或重复");
				usedCardIds.add(id);
				return card;
			}),
		}),
	);
	if (usedCardIds.size !== cards.size) throw new Error("卡片未归属任何列");
	return {
		...previous,
		workspaceState: {
			...update.workspace,
			board: { columns },
			sessions: applySessions(previous.workspaceState.sessions, update.sessions),
		},
	};
}
