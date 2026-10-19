import { getDefaultProjectVisualIdentity, type ProjectVisualIdentity } from "@runtime-project-visual-identity";
import {
	BookOpen,
	Bot,
	BrainCircuit,
	BriefcaseBusiness,
	ChartNoAxesCombined,
	ClipboardList,
	Cpu,
	Flame,
	FlaskConical,
	FolderGit2,
	GitBranch,
	GitCompareArrows,
	Globe,
	GraduationCap,
	KanbanSquare,
	Landmark,
	Layers,
	LayoutDashboard,
	LibraryBig,
	Lightbulb,
	Megaphone,
	Network,
	Palette,
	PenLine,
	Plug,
	Puzzle,
	Rocket,
	Scale,
	Settings2,
	Shapes,
	ShieldCheck,
	Ship,
	Terminal,
	Waves,
	Workflow,
	Wrench,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { fetchProjectIconImageDataUrl } from "@/runtime/project-visual-identity-query";
import type { RuntimeProjectSummary } from "@/runtime/types";

export const PROJECT_PRESET_ICON_COMPONENTS = {
	LayoutDashboard,
	KanbanSquare,
	ClipboardList,
	FolderGit2,
	GitBranch,
	GitCompareArrows,
	Bot,
	BrainCircuit,
	Cpu,
	Network,
	Terminal,
	Wrench,
	BookOpen,
	LibraryBig,
	GraduationCap,
	FlaskConical,
	ChartNoAxesCombined,
	Lightbulb,
	ShieldCheck,
	Scale,
	BriefcaseBusiness,
	Landmark,
	Globe,
	Megaphone,
	PenLine,
	Palette,
	Shapes,
	Flame,
	Waves,
	Ship,
	Layers,
	Workflow,
	Settings2,
	Plug,
	Puzzle,
	Rocket,
};
export const PROJECT_PRESET_ICON_CHINESE_NAMES = {
	LayoutDashboard: "仪表板",
	KanbanSquare: "看板",
	ClipboardList: "任务清单",
	FolderGit2: "项目文件夹",
	GitBranch: "分支图谱",
	GitCompareArrows: "差异比较",
	Bot: "机器人",
	BrainCircuit: "思考网络",
	Cpu: "处理器",
	Network: "编排网络",
	Terminal: "终端",
	Wrench: "工具扳手",
	BookOpen: "打开的书",
	LibraryBig: "知识书架",
	GraduationCap: "学位帽",
	FlaskConical: "实验烧瓶",
	ChartNoAxesCombined: "分析图表",
	Lightbulb: "思想灯泡",
	ShieldCheck: "校验盾牌",
	Scale: "天平",
	BriefcaseBusiness: "业务公文包",
	Landmark: "机构",
	Globe: "网站",
	Megaphone: "扩音器",
	PenLine: "写作笔",
	Palette: "调色板",
	Shapes: "抽象形状",
	Flame: "火焰",
	Waves: "波浪",
	Ship: "船",
	Layers: "工作空间层叠",
	Workflow: "工作流",
	Settings2: "配置滑杆",
	Plug: "集成插头",
	Puzzle: "能力拼图",
	Rocket: "火箭",
};
export const PROJECT_VISUAL_COLOR_CHINESE_NAMES = {
	slate: "石板灰",
	blue: "蓝",
	cyan: "青",
	teal: "蓝绿",
	green: "绿",
	lime: "黄绿",
	amber: "琥珀",
	orange: "橙",
	red: "红",
	rose: "玫红",
	purple: "紫",
	indigo: "靛蓝",
};

const ProjectVisualIdentityContext = createContext<ReadonlyMap<string, RuntimeProjectSummary>>(new Map());
export function ProjectVisualIdentityProvider({
	projects,
	children,
}: {
	projects: readonly RuntimeProjectSummary[];
	children: ReactNode;
}) {
	const byWorkspaceId = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
	return (
		<ProjectVisualIdentityContext.Provider value={byWorkspaceId}>{children}</ProjectVisualIdentityContext.Provider>
	);
}

export function ProjectIcon({
	project,
	workspaceId,
	projectName,
	visualIdentity,
	size = 18,
	imagePreviewDataUrl,
	className,
}: {
	project?: Pick<RuntimeProjectSummary, "id" | "name" | "visualIdentity">;
	workspaceId?: string;
	projectName?: string;
	visualIdentity?: ProjectVisualIdentity;
	size?: number;
	imagePreviewDataUrl?: string;
	className?: string;
}) {
	const projectsByWorkspaceId = useContext(ProjectVisualIdentityContext);
	const resolvedProject = project ?? projectsByWorkspaceId.get(workspaceId ?? "");
	const resolvedWorkspaceId = resolvedProject?.id ?? workspaceId ?? "";
	const fallback = getDefaultProjectVisualIdentity(resolvedWorkspaceId, resolvedProject?.name ?? projectName ?? "");
	const identity = visualIdentity ?? resolvedProject?.visualIdentity ?? fallback;
	const [loadedImage, setLoadedImage] = useState<{ key: string; dataUrl: string } | null>(null);
	const [failedImageKey, setFailedImageKey] = useState<string | null>(null);
	const imageKey = `${resolvedWorkspaceId}:${identity.imageAssetId ?? ""}`;
	useEffect(() => {
		if (identity.iconSource !== "uploaded_image" || !identity.imageAssetId || imagePreviewDataUrl) return;
		let active = true;
		fetchProjectIconImageDataUrl(resolvedWorkspaceId, identity.imageAssetId).then(
			(dataUrl) => {
				if (active) {
					setLoadedImage({ key: imageKey, dataUrl });
					setFailedImageKey(null);
				}
			},
			() => {
				if (active) setFailedImageKey(imageKey);
			},
		);
		return () => {
			active = false;
		};
	}, [identity.iconSource, identity.imageAssetId, resolvedWorkspaceId, imageKey, imagePreviewDataUrl]);
	const imageDataUrl = imagePreviewDataUrl ?? (loadedImage?.key === imageKey ? loadedImage.dataUrl : null);
	const displayedIdentity = failedImageKey === imageKey ? fallback : identity;
	const color = `var(--color-project-identity-${displayedIdentity.colorId})`;
	if (identity.iconSource === "uploaded_image" && imageDataUrl && failedImageKey !== imageKey)
		return (
			<img
				aria-hidden
				alt=""
				src={imageDataUrl}
				width={size}
				height={size}
				onError={() => setFailedImageKey(imageKey)}
				className={cn("shrink-0 rounded-sm border object-contain", className)}
				style={{ width: size, height: size, borderColor: color }}
			/>
		);
	const Icon = PROJECT_PRESET_ICON_COMPONENTS[displayedIdentity.presetIconId];
	return (
		<Icon
			aria-hidden
			size={size}
			className={cn("shrink-0", className)}
			style={{ color }}
			data-project-icon={displayedIdentity.presetIconId}
		/>
	);
}
