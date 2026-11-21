import type { RuntimeAppRouterInputs, RuntimeAppRouterOutputs } from "@runtime-trpc";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type GlobalMarkdownDraft = RuntimeAppRouterOutputs["globalMarkdownDraft"]["list"][number];
export type GlobalMarkdownDraftCreateInput = RuntimeAppRouterInputs["globalMarkdownDraft"]["create"];
export type GlobalMarkdownDraftUpdateInput = RuntimeAppRouterInputs["globalMarkdownDraft"]["update"];
export const globalMarkdownDraftApi = getRuntimeTrpcClient(null).globalMarkdownDraft;
