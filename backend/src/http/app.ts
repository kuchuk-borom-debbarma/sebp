import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import type { Container } from '@/container'
import { identityRoutes } from '@/modules/identity/http/routes'

/**
 * Root application. Mounts module routers and cross-cutting middleware.
 *
 * Routing lives here; wiring lives in container.ts. This file constructs nothing.
 */
export function createApp(container: Container) {
  const app = new OpenAPIHono()
  const { config } = container

  /**
   * CORS is configured from the environment and credentials are enabled, because
   * the session is a cookie. A wildcard origin with credentials is refused at
   * boot in production (see config.ts) — with credentials on, `*` would let any
   * site make authenticated requests on a user's behalf.
   */
  app.use(
    '/api/*',
    cors({
      origin: [...config.http.corsAllowedOrigins],
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  )

  app.route('/api/v1', identityRoutes(container.identity))

  /**
   * Mounted so better-auth's own endpoints (session refresh, sign-out) are
   * reachable. This is one of only two places in the codebase permitted to touch
   * better-auth directly (CONVE-15).
   */
  app.all('/api/auth/*', (c) => container.identity.auth.handler(c.req.raw))

  app.get('/health', (c) => c.json({ status: 'ok' }))

  /**
   * The spec is generated from the SAME Zod schemas that validate requests, so
   * it cannot drift from the implementation. Swagger UI simply renders it.
   */
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'sebp API',
      version: '1',
      description:
        'Startup programme platform. Sign-up is OTP-verified and password-backed; ' +
        'sign-in is password-only so a mail outage cannot lock out existing users.',
    },
  })

  if (config.http.swaggerEnabled) {
    app.get('/docs', swaggerUI({ url: '/openapi.json' }))
  }

  return app
}
