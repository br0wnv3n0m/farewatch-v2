// Farewatch v2 watch server (Cloudflare Worker + D1). Entry point: handlers only.
import { handle } from './app.ts';
import type { Env } from './http.ts';

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;
