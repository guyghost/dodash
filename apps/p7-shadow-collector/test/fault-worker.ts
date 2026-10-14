import worker, { type Env, P7Campaign } from "../src/worker.js";
export default worker;
export class FaultCampaign extends P7Campaign {
	constructor(ctx: DurableObjectState, env: Env & { FAIL_EXPORT?: string }) {
		super(ctx, {
			...env,
			ARCHIVE: new Proxy(env.ARCHIVE, {
				get(target, key) {
					if (key === "put" && env.FAIL_EXPORT === "after-put")
						return async (...args: Parameters<R2Bucket["put"]>) => {
							await target.put(...args);
							throw new Error("INJECTED_ACK_FAILURE");
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		});
	}
}
