import { z } from "zod";

export const PROJECT_PRESET_ICON_IDS = [
	"LayoutDashboard",
	"KanbanSquare",
	"ClipboardList",
	"FolderGit2",
	"GitBranch",
	"GitCompareArrows",
	"Bot",
	"BrainCircuit",
	"Cpu",
	"Network",
	"Terminal",
	"Wrench",
	"BookOpen",
	"LibraryBig",
	"GraduationCap",
	"FlaskConical",
	"ChartNoAxesCombined",
	"Lightbulb",
	"ShieldCheck",
	"Scale",
	"BriefcaseBusiness",
	"Landmark",
	"Globe",
	"Megaphone",
	"PenLine",
	"Palette",
	"Shapes",
	"Flame",
	"Waves",
	"Ship",
	"Layers",
	"Workflow",
	"Settings2",
	"Plug",
	"Puzzle",
	"Rocket",
] as const;
export const PROJECT_VISUAL_COLOR_IDS = [
	"slate",
	"blue",
	"cyan",
	"teal",
	"green",
	"lime",
	"amber",
	"orange",
	"red",
	"rose",
	"purple",
	"indigo",
] as const;
export const projectPresetIconIdSchema = z.enum(PROJECT_PRESET_ICON_IDS);
export const projectVisualColorIdSchema = z.enum(PROJECT_VISUAL_COLOR_IDS);
export const projectIconImageAssetIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectVisualIdentitySchema = z
	.object({
		iconSource: z.enum(["preset", "uploaded_image"]),
		presetIconId: projectPresetIconIdSchema,
		colorId: projectVisualColorIdSchema,
		imageAssetId: projectIconImageAssetIdSchema.nullable(),
	})
	.refine(
		(identity) =>
			identity.iconSource === "uploaded_image" ? identity.imageAssetId !== null : identity.imageAssetId === null,
		"项目图标来源与图片资产不一致",
	);
export type ProjectVisualIdentity = z.infer<typeof projectVisualIdentitySchema>;
export type ProjectPresetIconId = z.infer<typeof projectPresetIconIdSchema>;
export type ProjectVisualColorId = z.infer<typeof projectVisualColorIdSchema>;

export const MAX_PROJECT_ICON_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_ICON_IMAGE_DIMENSION = 4096;
export const projectIconImageUploadSchema = z.object({
	mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
	base64Content: z
		.string()
		.min(4)
		.max(Math.ceil(MAX_PROJECT_ICON_UPLOAD_BYTES / 3) * 4),
});
export const setProjectVisualIdentityRequestSchema = z
	.object({
		workspaceId: z.string().min(1),
		iconSource: z.enum(["preset", "uploaded_image"]),
		presetIconId: projectPresetIconIdSchema,
		colorId: projectVisualColorIdSchema,
		imageAssetId: projectIconImageAssetIdSchema.nullable(),
		imageUpload: projectIconImageUploadSchema.optional(),
	})
	.refine(
		(request) =>
			request.iconSource === "preset"
				? !request.imageUpload && request.imageAssetId === null
				: Boolean(request.imageUpload) !== Boolean(request.imageAssetId),
		"请选择已有图片或上传一张新图片",
	);
export type SetProjectVisualIdentityRequest = z.infer<typeof setProjectVisualIdentityRequestSchema>;
export const resetProjectVisualIdentityRequestSchema = z.object({ workspaceId: z.string().min(1) });
export const readProjectIconImageRequestSchema = z.object({
	workspaceId: z.string().min(1),
	imageAssetId: projectIconImageAssetIdSchema,
});
export const readProjectIconImageResponseSchema = z.object({
	mediaType: z.literal("image/png"),
	base64Content: z.string(),
});

const PROJECT_DEFAULT_VISUAL_IDENTITY_SUGGESTIONS: Readonly<
	Record<string, readonly [ProjectPresetIconId, ProjectVisualColorId]>
> = {
	"cline-kanban": ["KanbanSquare", "blue"],
	"vibe-kanban": ["LayoutDashboard", "cyan"],
	"my-kanban": ["ClipboardList", "teal"],
	"review-validate-fix": ["ShieldCheck", "green"],
	"trace-of-thought": ["BrainCircuit", "purple"],
	"trace-of-thought-landing-page": ["Globe", "cyan"],
	"trace-of-thought-marketing": ["Megaphone", "orange"],
	"trace-of-thought-legal": ["Scale", "slate"],
	"philosophy-of-ai-systems": ["Lightbulb", "amber"],
	"doctoral-research-proposal": ["GraduationCap", "indigo"],
	"ai-analysis": ["ChartNoAxesCombined", "blue"],
	"team-knowledge": ["LibraryBig", "green"],
	novel: ["PenLine", "rose"],
	"summer-camp-projects": ["Rocket", "orange"],
	"workflow-plugin-design-system": ["Workflow", "indigo"],
	"orchestration-infra": ["Network", "slate"],
	"my-ai-setup": ["Settings2", "cyan"],
	"agent-skills": ["Puzzle", "purple"],
	iii: ["Plug", "teal"],
	orca: ["Waves", "cyan"],
	"better-ccflare": ["Flame", "amber"],
	"oh-my-pi": ["Terminal", "purple"],
	"diff-level-agent-work-attribution": ["GitCompareArrows", "orange"],
	fractelier: ["Layers", "rose"],
	"agent-conversation-exploration-thread-graph": ["GitBranch", "purple"],
	"project theseus": ["Ship", "teal"],
	openrig: ["Wrench", "orange"],
	instrumentality: ["Shapes", "red"],
};

export function getDefaultProjectVisualIdentity(workspaceId: string, projectName: string): ProjectVisualIdentity {
	let stableHash = 2166136261;
	for (const character of workspaceId) stableHash = Math.imul(stableHash ^ character.charCodeAt(0), 16777619) >>> 0;
	const lowercaseProjectName = projectName.toLowerCase();
	const defaultVisualIdentitySuggestion = Object.hasOwn(
		PROJECT_DEFAULT_VISUAL_IDENTITY_SUGGESTIONS,
		lowercaseProjectName,
	)
		? PROJECT_DEFAULT_VISUAL_IDENTITY_SUGGESTIONS[lowercaseProjectName]
		: undefined;
	const [presetIconId, colorId] = defaultVisualIdentitySuggestion ?? [
		"FolderGit2",
		PROJECT_VISUAL_COLOR_IDS[stableHash % PROJECT_VISUAL_COLOR_IDS.length] ?? "slate",
	];
	return { iconSource: "preset", presetIconId, colorId, imageAssetId: null };
}
