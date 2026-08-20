import { z } from '@hono/zod-openapi'

/**
 * Request and response schemas for the identity routes.
 *
 * These are the SINGLE source of truth: the same schema validates the incoming
 * request AND describes it in `/openapi.json`, which the Swagger UI renders and
 * the frontend generates its client from. The spec therefore cannot drift from
 * the implementation — there is no second definition to fall out of step.
 */

/**
 * Emails are normalised (trimmed, lowercased) on the way in, so
 * `Founder@Example.com` and `founder@example.com` are the same account. Applied
 * consistently on read and write — normalising only one side fails
 * asymmetrically and intermittently, which is worse than not doing it at all.
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254) // RFC 5321 maximum; also stops absurd inputs reaching the database
  .openapi({ example: 'founder@example.com' })

const CodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,10}$/, 'Code must be 4-10 digits')
  .openapi({ example: '123456', description: 'The one-time code that was delivered' })

/**
 * Only a maximum is enforced here. The MINIMUM is checked in the use-case
 * against configured policy, because the limit is configuration rather than a
 * compile-time constant — and because the use-case must check it BEFORE
 * consuming the single-use OTP.
 *
 * The maximum exists to bound scrypt's work: hashing is deliberately expensive
 * (~67ms), so an unbounded password is a cheap way to burn CPU.
 */
const PasswordSchema = z
  .string()
  .min(1)
  .max(200)
  .openapi({ example: 'correct horse battery staple' })

export const RequestOtpBody = z
  .object({
    email: EmailSchema,
    purpose: z.enum(['signup', 'password_reset']).openapi({ example: 'signup' }),
  })
  .openapi('RequestOtpBody')

export const CompleteSignupBody = z
  .object({
    email: EmailSchema,
    code: CodeSchema,
    password: PasswordSchema,
  })
  .openapi('CompleteSignupBody')

export const SignInBody = z
  .object({ email: EmailSchema, password: PasswordSchema })
  .openapi('SignInBody')

export const ResetPasswordBody = z
  .object({ email: EmailSchema, code: CodeSchema, password: PasswordSchema })
  .openapi('ResetPasswordBody')

export const AcceptedResponse = z
  .object({
    status: z.literal('accepted').openapi({ example: 'accepted' }),
  })
  .openapi('AcceptedResponse')

export const SessionResponse = z
  .object({
    userId: z.string().openapi({ example: '018f4c1e-7b2a-7000-8000-1a2b3c4d5e6f' }),
  })
  .openapi('SessionResponse')

export const MeResponse = z
  .object({
    userId: z.string(),
    email: z.string(),
  })
  .openapi('MeResponse')

export const ErrorResponse = z
  .object({
    error: z.string().openapi({ example: 'invalid_credentials' }),
    message: z.string().openapi({ example: 'Email or password is incorrect.' }),
    /** Present on 422 only: which fields failed and why. */
    fields: z.record(z.string(), z.string()).optional(),
  })
  .openapi('ErrorResponse')
