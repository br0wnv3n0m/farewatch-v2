// Farewatch v2 watch server (Cloudflare Worker + D1). Entry point: handlers only.
import { handle } from './app.ts';
import type { Env } from './http.ts';
import { scheduled } from './monitor.ts';

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  // Cron (wrangler.jsonc): clean-up, fare alert retries, "checks have stopped" monitor.
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(scheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
