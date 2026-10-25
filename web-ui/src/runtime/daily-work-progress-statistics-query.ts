import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeClaimDailyWorkProgressCelebrationsRequest,
	RuntimeDailyWorkProgressRequest,
} from "@/runtime/types";
export function readDailyWorkProgressSummary(input: RuntimeDailyWorkProgressRequest) {
	return getRuntimeTrpcClient(null).dailyWorkProgressStatistics.getSummary.query(input);
}
export function claimDailyWorkProgressCelebrations(input: RuntimeClaimDailyWorkProgressCelebrationsRequest) {
	return getRuntimeTrpcClient(null).dailyWorkProgressStatistics.claimCelebrations.mutate(input);
}
