import { buildContainer } from './container'
import { createApp } from './http/app'

/**
 * Worker entrypoint. Deliberately thin: build the container from the
 * environment, hand the request to the Hono app.
 *
 * The container is rebuilt per request rather than cached at module scope. On
 * Workers that is cheap — everything it constructs is a plain object or a
 * closure over a binding — and it avoids an isolate reused across environments
 * ever serving stale configuration.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = new URL(request.url).origin
    const container = buildContainer(env, origin)
    return createApp(container).fetch(request, env)
  },
} satisfies ExportedHandler<Env>
