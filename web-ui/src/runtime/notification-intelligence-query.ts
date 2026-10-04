import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
export function notificationIntelligenceClient() {
	return getRuntimeTrpcClient(null).notificationIntelligence;
}
export type NotificationIntelligenceSettings = Awaited<
	ReturnType<ReturnType<typeof notificationIntelligenceClient>["getSettings"]["query"]>
>["settings"];
export type NotificationProviderProfile = Awaited<
	ReturnType<ReturnType<typeof notificationIntelligenceClient>["getSettings"]["query"]>
>["providers"][number];
export type ArchivedNotificationCandidate = Awaited<
	ReturnType<ReturnType<typeof notificationIntelligenceClient>["listArchive"]["query"]>
>["entries"][number];
