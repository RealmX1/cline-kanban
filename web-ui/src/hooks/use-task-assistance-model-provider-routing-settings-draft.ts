import { useEffect, useState } from "react";
import {
	readGlobalTaskAssistanceModelProviderRoutingSettings,
	saveGlobalTaskAssistanceModelProviderRoutingSettings,
	type TaskAssistanceModelProviderRoutingSettings,
} from "@/runtime/task-analysis-query";

export function useTaskAssistanceModelProviderRoutingSettingsDraft(open: boolean) {
	const [settings, setSettings] = useState<TaskAssistanceModelProviderRoutingSettings | null>(null);
	const [savedSettings, setSavedSettings] = useState<TaskAssistanceModelProviderRoutingSettings | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		setSettings(null);
		setSavedSettings(null);
		setLoadError(null);
		if (!open) return;
		let superseded = false;
		void readGlobalTaskAssistanceModelProviderRoutingSettings()
			.then((result) => {
				if (!superseded) {
					setSettings(result);
					setSavedSettings(result);
				}
			})
			.catch((failure) => {
				if (!superseded) setLoadError(failure instanceof Error ? failure.message : "无法读取任务分析设置");
			});
		return () => {
			superseded = true;
		};
	}, [open]);
	const hasUnsavedChanges = JSON.stringify(settings) !== JSON.stringify(savedSettings);
	return {
		settings,
		setSettings,
		loadError,
		hasUnsavedChanges,
		save: async () => {
			if (!settings) return;
			const saved = await saveGlobalTaskAssistanceModelProviderRoutingSettings(settings);
			setSettings(saved);
			setSavedSettings(saved);
		},
	};
}
