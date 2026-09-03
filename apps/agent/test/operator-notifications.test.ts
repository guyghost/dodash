import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
	classifyOperatorNotifications,
	createOperatorNotificationDeduper,
	emitOperatorNotifications,
	type OperatorNotificationSettings,
	resolveOperatorNotificationSettings,
	signOperatorNotificationPayload,
} from "../src/operator-notifications.js";
import type { TradingTelemetryEvent } from "../src/telemetry.js";

const SECRET = "0".repeat(32);

const settings = (): OperatorNotificationSettings => ({
	webhookUrl: "https://operator.example.com/hook",
	secret: SECRET,
});

const baseEvent = (): TradingTelemetryEvent => ({
	schemaVersion: 1,
	type: "cycle.completed",
	timestamp: 1_700_000_000_000,
	agentId: "agent-1",
	productId: "GRT-USD",
	executionMode: "paper",
	phase: "persisting",
	outcome: "ORDER_CONFIRMED",
	errorCode: null,
	latencyMs: 12,
	dailyPnl: 5,
	accountEquity: null,
	positionQuantity: null,
	otherExposureNotional: 100,
	executionObserved: false,
	openOrderCount: null,
});

describe("resolveOperatorNotificationSettings", () => {
	it("est inactif quand les deux secrets sont absents", () => {
		expect(resolveOperatorNotificationSettings({})).toEqual({
			ok: false,
			error: { code: "OPERATOR_NOTIFICATIONS_DISABLED" },
		});
	});

	it.each([
		["https://operator.example.com/hook", "court"],
		["not-a-url", "0".repeat(32)],
		["ftp://operator.example.com/hook", "0".repeat(32)],
	])("rejette la configuration invalide (%s)", (url, secret) => {
		expect(
			resolveOperatorNotificationSettings({
				OPERATOR_NOTIFY_WEBHOOK_URL: url,
				OPERATOR_NOTIFY_SECRET: secret,
			}),
		).toEqual({
			ok: false,
			error: { code: "OPERATOR_NOTIFICATIONS_INVALID" },
		});
	});

	it("accepte un webhook https et un secret d'au moins 32 caractères", () => {
		expect(
			resolveOperatorNotificationSettings({
				OPERATOR_NOTIFY_WEBHOOK_URL: "https://operator.example.com/hook",
				OPERATOR_NOTIFY_SECRET: SECRET,
			}),
		).toEqual({
			ok: true,
			value: {
				webhookUrl: "https://operator.example.com/hook",
				secret: SECRET,
			},
		});
	});
});

describe("classifyOperatorNotifications", () => {
	it("cycle FAILED produit CYCLE_FAILED", () => {
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "FAILED",
				errorCode: "INVALID_RESPONSE",
				dailyPnl: 0,
				otherExposureNotional: 0,
			}),
		).toEqual(["CYCLE_FAILED"]);
	});

	it("ORDER_OUTCOME_UNKNOWN produit sa classe même si le cycle confirme", () => {
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "ORDER_CONFIRMED",
				errorCode: "ORDER_OUTCOME_UNKNOWN",
				dailyPnl: 0,
				otherExposureNotional: 0,
			}),
		).toEqual(["ORDER_OUTCOME_UNKNOWN"]);
	});

	it("le seuil de PnL quotidien figé produit DAILY_PNL_BREACH", () => {
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "NO_ACTION",
				errorCode: null,
				dailyPnl: -1_000,
				otherExposureNotional: 0,
			}),
		).toEqual(["DAILY_PNL_BREACH"]);
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "NO_ACTION",
				errorCode: null,
				dailyPnl: -999.99,
				otherExposureNotional: 0,
			}),
		).toEqual([]);
	});

	it("le plafond d'exposition figé produit EXPOSURE_BREACH", () => {
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "NO_ACTION",
				errorCode: null,
				dailyPnl: 0,
				otherExposureNotional: 20_001,
			}),
		).toEqual(["EXPOSURE_BREACH"]);
	});

	it("un enregistrement peut satisfaire plusieurs classes", () => {
		expect(
			classifyOperatorNotifications({
				kind: "cycle",
				outcome: "FAILED",
				errorCode: "ORDER_OUTCOME_UNKNOWN",
				dailyPnl: -2_000,
				otherExposureNotional: 30_000,
			}),
		).toEqual([
			"CYCLE_FAILED",
			"ORDER_OUTCOME_UNKNOWN",
			"DAILY_PNL_BREACH",
			"EXPOSURE_BREACH",
		]);
	});

	it("control FAILED produit uniquement CONTROL_FAILED", () => {
		expect(
			classifyOperatorNotifications({
				kind: "control",
				outcome: "FAILED",
				errorCode: null,
				dailyPnl: -2_000,
				otherExposureNotional: 30_000,
			}),
		).toEqual(["CONTROL_FAILED"]);
		expect(
			classifyOperatorNotifications({
				kind: "control",
				outcome: "CANCELLED",
				errorCode: null,
				dailyPnl: null,
				otherExposureNotional: null,
			}),
		).toEqual([]);
	});
});

describe("createOperatorNotificationDeduper", () => {
	it("supprime une classe répétée dans la fenêtre et relâche ensuite", () => {
		let clock = 0;
		const deduper = createOperatorNotificationDeduper(() => clock);
		expect(deduper.shouldSend("a", "CYCLE_FAILED")).toBe(true);
		deduper.markSent("a", "CYCLE_FAILED");
		clock = 59_999;
		expect(deduper.shouldSend("a", "CYCLE_FAILED")).toBe(false);
		clock = 60_000;
		expect(deduper.shouldSend("a", "CYCLE_FAILED")).toBe(true);
	});

	it("ne déduplique pas entre agents ni entre classes", () => {
		const clock = 0;
		const deduper = createOperatorNotificationDeduper(() => clock);
		deduper.markSent("a", "CYCLE_FAILED");
		expect(deduper.shouldSend("b", "CYCLE_FAILED")).toBe(true);
		expect(deduper.shouldSend("a", "CONTROL_FAILED")).toBe(true);
	});
});

describe("signOperatorNotificationPayload", () => {
	it("produit le HMAC-SHA256 hexadécimal du corps brut", async () => {
		const body = JSON.stringify({ schemaVersion: 1 });
		const signature = await signOperatorNotificationPayload(SECRET, body);
		expect(signature).toBe(
			createHmac("sha256", SECRET).update(body).digest("hex"),
		);
	});
});

describe("emitOperatorNotifications", () => {
	const harness = (options?: {
		fetchMock?: ReturnType<typeof vi.fn<typeof fetch>>;
		randomUUID?: () => string;
	}) => {
		const logger = { log: vi.fn(), error: vi.fn() };
		const fetchMock =
			options?.fetchMock ??
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json({}, { status: 200 }));
		const randomUUID = options?.randomUUID ?? (() => "notification-1");
		const run = (
			event: TradingTelemetryEvent,
			kind: "cycle" | "control" = "cycle",
			activeSettings: OperatorNotificationSettings | undefined = settings(),
		) =>
			emitOperatorNotifications(
				activeSettings,
				kind,
				event,
				createOperatorNotificationDeduper(),
				logger,
				{ fetch: fetchMock, randomUUID },
			);
		return { logger, fetchMock, randomUUID, run };
	};

	it("envoie exactement une notification par classe satisfaite", async () => {
		const event = {
			...baseEvent(),
			outcome: "FAILED",
			errorCode: "ORDER_OUTCOME_UNKNOWN",
		};
		const { fetchMock, run } = harness();
		run(event);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const bodies = fetchMock.mock.calls.map(([, request]) =>
			String(request?.body),
		);
		expect(bodies.some((body) => body.includes('"class":"CYCLE_FAILED"'))).toBe(
			true,
		);
		expect(
			bodies.some((body) => body.includes('"class":"ORDER_OUTCOME_UNKNOWN"')),
		).toBe(true);
	});

	it("signe le corps brut exactement envoyé", async () => {
		const { fetchMock, run } = harness();
		const event = { ...baseEvent(), outcome: "FAILED" };
		run(event);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const call = fetchMock.mock.calls[0];
		if (call === undefined) throw new Error("expected a fetch call");
		const [url, request] = call;
		const body = String(request?.body);
		expect(url).toBe("https://operator.example.com/hook");
		expect(request?.headers).toMatchObject({
			"content-type": "application/json",
			"x-dodash-signature": createHmac("sha256", SECRET)
				.update(body)
				.digest("hex"),
		});
		expect(JSON.parse(body)).toMatchObject({
			schemaVersion: 1,
			notificationId: "notification-1",
			class: "CYCLE_FAILED",
			agentId: "agent-1",
			productId: "GRT-USD",
			errorCode: null,
		});
	});

	it("journalise l'échec définitif sans lever d'exception", async () => {
		const { fetchMock, logger, run } = harness({
			fetchMock: vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json({}, { status: 500 })),
		});
		run({ ...baseEvent(), outcome: "FAILED" });
		await vi.waitFor(() =>
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("operator-notification.delivery_failed"),
			),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("ne retente jamais après une réponse 4xx", async () => {
		const { fetchMock, run } = harness({
			fetchMock: vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json({}, { status: 400 })),
		});
		run({ ...baseEvent(), outcome: "FAILED" });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retente une fois uniquement sur échec réseau", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(Response.json({}, { status: 200 }));
		const { run } = harness({ fetchMock });
		run({ ...baseEvent(), outcome: "FAILED" });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it("n'envoie rien quand le canal est désactivé", () => {
		const { fetchMock, run } = harness();
		run({ ...baseEvent(), outcome: "FAILED" }, "cycle", undefined);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("n'envoie rien pour un cycle sans classe satisfaite", () => {
		const { fetchMock, run } = harness();
		run(baseEvent());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("utilise un identifiant de notification par payload", async () => {
		let counter = 0;
		const { fetchMock, run } = harness({
			randomUUID: () => {
				counter += 1;
				return `notification-${counter}`;
			},
		});
		run({
			...baseEvent(),
			outcome: "FAILED",
			errorCode: "ORDER_OUTCOME_UNKNOWN",
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const ids = fetchMock.mock.calls.map(
			([, request]) =>
				(JSON.parse(String(request?.body)) as { notificationId: string })
					.notificationId,
		);
		expect(new Set(ids).size).toBe(2);
	});

	it("la signature vérifie le corps avec le secret côté récepteur", async () => {
		const { fetchMock, run } = harness();
		run({ ...baseEvent(), outcome: "FAILED" });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const call = fetchMock.mock.calls[0];
		if (call === undefined) throw new Error("expected a fetch call");
		const [, request] = call;
		if (request === undefined) throw new Error("expected a request init");
		const body = String(request.body);
		const signature = String(
			(request.headers as Record<string, string>)["x-dodash-signature"],
		);
		expect(
			createHash("sha256")
				.update(createHmac("sha256", SECRET).update(body).digest())
				.digest("hex"),
		).not.toBe(signature);
		expect(signature).toBe(
			createHmac("sha256", SECRET).update(body).digest("hex"),
		);
	});
});
