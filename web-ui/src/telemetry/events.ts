import posthog from "posthog-js";

import type { RuntimeAgentId } from "@/runtime/types";
import { isTelemetryEnabled } from "@/telemetry/posthog-config";
import type { TaskAutoReviewMode } from "@/types";

export type TelemetrySelectedAgentId = RuntimeAgentId | "unknown";

interface TelemetryEventMap {
	task_created: {
		selected_agent_id: TelemetrySelectedAgentId;
		start_in_plan_mode: boolean;
		auto_review_mode?: TaskAutoReviewMode;
		prompt_character_count: number;
	};
	task_resumed_from_trash: Record<string, never>;
}

export function toTelemetrySelectedAgentId(agentId: RuntimeAgentId | null | undefined): TelemetrySelectedAgentId {
	return agentId ?? "unknown";
}

function captureTelemetryEvent<EventName extends keyof TelemetryEventMap>(
	eventName: EventName,
	properties: TelemetryEventMap[EventName],
): void {
	if (!isTelemetryEnabled()) {
		return;
	}

	try {
		posthog.capture(eventName, properties);
	} catch {
		// Telemetry failures should never block user actions.
	}
}

export function trackTaskCreated(properties: TelemetryEventMap["task_created"]): void {
	captureTelemetryEvent("task_created", properties);
}

export function trackTaskResumedFromTrash(): void {
	captureTelemetryEvent("task_resumed_from_trash", {});
}
