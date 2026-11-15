import { parseMultiProductAgentConfiguration } from "../../src/configuration.js";
import {
	createPortfolioMachineSession,
	initialProductRuntime,
} from "../../src/portfolio-runtime.js";
import { getAgentByName } from "agents";
import { TradingAgent } from "../../src/trading-agent.js";
import { INITIAL_AGENT_STATE } from "../../src/state.js";
import { parseAgentConfiguration } from "../../src/configuration.js";
import { createTradingMachineSession } from "../../src/machine-session.js";

// Local test adapter: state setup and observation clock only. SDK scheduling,
// alarm dispatch, effects, interpreter and SQLite stay inherited and genuine.
export class PaperRuntimeAgent extends TradingAgent {
	async test(input: any) {
		await (this as any).__unsafe_ensureInitialized();
		const original = Date.now;
		Date.now = () => input.now ?? original();
		try {
			(this as any).ensureTradingPersistenceSchema();
			this
				.sql`CREATE TABLE IF NOT EXISTS runtime_telemetry (point TEXT NOT NULL)`;
			(this.env as any).TRADING_TELEMETRY = {
				writeDataPoint: (point: any) =>
					this
						.sql`INSERT INTO runtime_telemetry(point) VALUES (${JSON.stringify(point)})`,
			};
			if (input.action === "prepare") {
				const config = parseAgentConfiguration({
					productId: "BTC-USD",
					candleLimit: 100,
					maxMarketStalenessMs: input.staleness ?? 7_200_000,
					strategyIds: ["rsi-reversion"],
				});
				if (!config.ok) throw new Error("fixture configuration rejected");
				const session = createTradingMachineSession({
					agentId: this.name,
					strategyIds: ["rsi-reversion"],
					maxMarketStalenessMs: input.staleness ?? 7_200_000,
				});
				session.send({
					type: "START_REQUESTED",
					permissions: { canControl: true, canTrade: true },
				});
				session.send({
					type: "SCHEDULE_SUCCEEDED",
					nextWakeAt: input.now + 60_000,
				});
				if (input.pending) {
					session.send({
						type: "ALARM_FIRED",
						cycleId: "fixture-old",
						triggeredAt: input.now,
					});
					session.send({
						type: "ACCOUNT_RECONCILED",
						snapshotId: "fixture-account",
					});
					session.send({
						type: "MARKET_DATA_FAILED",
						error: {
							phase: "market-data",
							code: "RATE_LIMITED",
							retryable: true,
						},
					});
				}
				this.setState({
					...INITIAL_AGENT_STATE,
					configuration: config.value,
					machine: session.record,
					enabled: true,
					portfolio: { cash: 10_000, positionQuantity: 2, averagePrice: 10 },
				});
				session.stop();
				if (input.multi) {
					const multi = parseMultiProductAgentConfiguration({
						products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
						candleLimit: 100,
						maxMarketStalenessMs: input.staleness ?? 7_200_000,
						portfolioRisk: { maxGrossExposure: 20_000, maxDailyLoss: 2_000 },
					});
					if (!multi.ok) throw new Error("multi fixture rejected");
					const orchestrator = createPortfolioMachineSession({
						products: ["BTC-USD", "ETH-USD"],
						limits: { maxGrossExposure: 20_000, maxDailyLoss: 2_000 },
					});
					orchestrator.send({ type: "PORTFOLIO_STARTED" });
					const products = {
						"BTC-USD": initialProductRuntime(this.state.machine!, 10_000),
						"ETH-USD": initialProductRuntime(this.state.machine!, 10_000),
					};
					this.setState({
						...this.state,
						portfolioSession: {
							configuration: multi.value,
							portfolio: orchestrator.record,
							products,
						},
					});
					orchestrator.stop();
				}
				if (input.pending)
					await (this as any).checkpoint(
						{
							cycleId: "fixture-old",
							triggeredAt: input.now,
							marketRetry: {
								attempt: 1,
								nextRetryAt: input.now + 60_000,
								deadlineAt: input.now + (input.staleness ?? 7_200_000),
								errorCode: "RATE_LIMITED",
							},
						},
						input.multi ? "BTC-USD" : undefined,
					);
				if (input.multi)
					await (this as any).persistPortfolio(
						this.state.portfolioSession!.portfolio,
					);
			} else if (input.action === "grid") await this.scheduledTick();
			else if (input.action === "retry") await this.retryTick(input.payload);
			else if (input.action === "dispatch") {
				await this.schedule(
					new Date(input.now - 1_000),
					"retryTick",
					input.payload,
				);
				await this.alarm();
			}
			return {
				state: this.state,
				schedules: this.getSchedules(),
				cycles: this.sql`SELECT * FROM dodash_cycles`.map((row) => row),
				orders: this.sql`SELECT * FROM dodash_orders`.map((row) => row),
				telemetry: this.sql`SELECT point FROM runtime_telemetry`.map((row) =>
					JSON.parse(String(row.point)),
				),
			};
		} finally {
			Date.now = original;
		}
	}
}
export default {
	async fetch(request: Request, env: any) {
		const input: any = await request.json();
		if (input.action === "market") {
			return env.MARKET_DATA.fetch("http://fixture/control", {
				method: "POST",
				body: JSON.stringify(input),
			});
		}
		const stub = await getAgentByName(
			env.TRADING_AGENT,
			input.name ?? "fixture",
		);
		return Response.json(await stub.test(input));
	},
};
