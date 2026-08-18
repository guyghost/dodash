export interface DashboardEdgeEnv {
  readonly ASSETS: Fetcher;
  readonly DASHBOARD_API: Fetcher;
}

export const handleDashboardEdgeRequest = (
  request: Request,
  env: DashboardEdgeEnv,
): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return env.DASHBOARD_API.fetch(request);
  }
  return env.ASSETS.fetch(request);
};

export default {
  fetch: handleDashboardEdgeRequest,
} satisfies ExportedHandler<DashboardEdgeEnv>;
