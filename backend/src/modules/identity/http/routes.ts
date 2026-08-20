import type { z } from '@hono/zod-openapi';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { respondWithError } from '@/http/middleware/error'
import type { IdentityModule } from '../module'
import {
  AcceptedResponse,
  CompleteSignupBody,
  ErrorResponse,
  RequestOtpBody,
  ResetPasswordBody,
  SessionResponse,
  SignInBody,
} from './schemas'

/**
 * Identity routes. Thin by design: validate, call one use-case, map the Result.
 * Business logic in a route handler is a bug (docs/codebase-structure.md §11).
 */

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

/** Best-effort caller IP for rate limiting. */
function callerIp(header: string | undefined): string {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by the client at
  // the edge. Falling back to a constant means all unknown callers share one
  // bucket — restrictive rather than permissive, which is the right direction.
  return header ?? 'unknown'
}

export function identityRoutes(identity: IdentityModule) {
  const app = new OpenAPIHono()

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/request-otp',
      tags: ['auth'],
      summary: 'Request a one-time code',
      description:
        'Sends a code to the address. Always returns 202, whether or not an ' +
        'account exists — reporting otherwise would let anyone enumerate accounts.',
      request: { body: json(RequestOtpBody, 'Address and purpose') },
      responses: {
        202: json(AcceptedResponse, 'Code sent if the address is deliverable'),
        429: json(ErrorResponse, 'Rate limited'),
        503: json(ErrorResponse, 'Delivery or storage unavailable'),
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const result = await identity.useCases.requestOtp({
        destination: body.email,
        purpose: body.purpose,
        ip: callerIp(c.req.header('CF-Connecting-IP')),
      })

      if (!result.ok) return respondWithError(c, result.error)
      return c.json({ status: 'accepted' as const }, 202)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/complete-signup',
      tags: ['auth'],
      summary: 'Create an account with a verified code and a password',
      description:
        'The code proves the address, so there is no separate email-verification ' +
        'step. The account does not exist until both are accepted.',
      request: { body: json(CompleteSignupBody, 'Address, code and chosen password') },
      responses: {
        201: json(SessionResponse, 'Account created and signed in'),
        400: json(ErrorResponse, 'Invalid code'),
        409: json(ErrorResponse, 'Address already registered'),
        410: json(ErrorResponse, 'Code expired'),
        422: json(ErrorResponse, 'Password does not meet policy'),
        429: json(ErrorResponse, 'Too many attempts'),
        503: json(ErrorResponse, 'Storage unavailable'),
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const result = await identity.useCases.completeSignup(body)

      if (!result.ok) return respondWithError(c, result.error)

      c.header('Set-Cookie', result.value.setCookie, { append: true })
      return c.json({ userId: result.value.userId as string }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/sign-in',
      tags: ['auth'],
      summary: 'Sign in with email and password',
      description:
        'OTP is a signup and recovery mechanism, not a login one — so a mail ' +
        'outage cannot lock out existing users.',
      request: { body: json(SignInBody, 'Credentials') },
      responses: {
        200: json(SessionResponse, 'Signed in'),
        401: json(ErrorResponse, 'Invalid credentials'),
        503: json(ErrorResponse, 'Auth backend unavailable'),
      },
    }),
    async (c) => {
      const result = await identity.useCases.signIn(c.req.valid('json'))
      if (!result.ok) return respondWithError(c, result.error)

      c.header('Set-Cookie', result.value.setCookie, { append: true })
      return c.json({ userId: result.value.userId as string }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/reset-password',
      tags: ['auth'],
      summary: 'Set a new password using a verified code',
      request: { body: json(ResetPasswordBody, 'Address, code and new password') },
      responses: {
        200: json(AcceptedResponse, 'Password updated'),
        400: json(ErrorResponse, 'Invalid code'),
        404: json(ErrorResponse, 'No account for that address'),
        410: json(ErrorResponse, 'Code expired'),
        422: json(ErrorResponse, 'Password does not meet policy'),
        429: json(ErrorResponse, 'Too many attempts'),
        503: json(ErrorResponse, 'Storage unavailable'),
      },
    }),
    async (c) => {
      const result = await identity.useCases.resetPassword(c.req.valid('json'))
      if (!result.ok) return respondWithError(c, result.error)
      return c.json({ status: 'accepted' as const }, 200)
    },
  )

  return app
}
