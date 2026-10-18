import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	ListPermanentlyDeletedTaskCardsRequest,
	PermanentlyDeletedTaskPromptVersionsRequest,
} from "@/runtime/types";

export function readPermanentlyDeletedTaskCards(input: ListPermanentlyDeletedTaskCardsRequest) {
	return getRuntimeTrpcClient(null).workUnit.listPermanentlyDeletedTaskCards.query(input);
}

export function readPermanentlyDeletedTaskPromptVersions(input: PermanentlyDeletedTaskPromptVersionsRequest) {
	return getRuntimeTrpcClient(null).workUnit.getPermanentlyDeletedTaskPromptVersions.query(input);
}
