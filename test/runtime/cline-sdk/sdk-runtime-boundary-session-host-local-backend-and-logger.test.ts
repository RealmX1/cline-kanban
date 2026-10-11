import { describe, expect, it, vi } from "vitest";

const clineCoreMocks = vi.hoisted(() => ({
	create: vi.fn(async () => ({ fakeSessionHost: true })),
	telemetryStub: { fakeTelemetry: true },
}));

vi.mock("@clinebot/core", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClineCore: { create: clineCoreMocks.create },
}));

vi.mock("../../../src/cline-sdk/cline-telemetry-service", () => ({
	getCliTelemetryService: () => clineCoreMocks.telemetryStub,
}));

import { createClineSdkSessionHost } from "../../../src/cline-sdk/sdk-runtime-boundary";

describe("createClineSdkSessionHost", () => {
	it("固定 backendMode:local（不触发 hub 守护进程 spawn），并注入 SDK logger", async () => {
		await createClineSdkSessionHost();

		expect(clineCoreMocks.create).toHaveBeenCalledTimes(1);
		expect(clineCoreMocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				backendMode: "local",
				logger: expect.objectContaining({
					debug: expect.any(Function),
					log: expect.any(Function),
					error: expect.any(Function),
				}),
				telemetry: clineCoreMocks.telemetryStub,
			}),
		);
	});
});
