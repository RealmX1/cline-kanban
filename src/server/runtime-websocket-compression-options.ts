import type { PerMessageDeflateOptions } from "ws";

export const RUNTIME_WEBSOCKET_COMPRESSION_OPTIONS = {
	threshold: 1024,
	serverNoContextTakeover: true,
	clientNoContextTakeover: true,
	concurrencyLimit: 4,
	zlibDeflateOptions: { level: 4 },
} satisfies PerMessageDeflateOptions;
