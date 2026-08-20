import type { Result } from '@/shared/result'

/**
 * Outbound message delivery — email today, SMS when phone verification lands.
 *
 * WHY A PORT: this is the seam the whole notification design rests on. Today it
 * is `ConsoleNotifier`, which prints to stdout so local development needs no
 * mail provider at all. Later it is Pingram. Swapping them is one line in the
 * composition root and zero lines anywhere else — no use-case, no route, and no
 * test changes when the provider changes.
 *
 * It is also why OTP delivery is NOT delegated to better-auth's built-in mailer:
 * that would bypass this port entirely and take the console adapter with it.
 *
 * CHANNEL-AGNOSTIC BY DESIGN: `destination` is an email address today and a
 * phone number later. Nothing downstream of this interface says "email".
 */

export type Channel = 'email' | 'sms'

export type Message = {
  readonly channel: Channel
  /** Email address or phone number. Never called "email" — see above. */
  readonly destination: string
  /**
   * Required, not optional. SMS channels ignore it, but making it optional
   * created a branch no caller could reach — every message has a subject.
   * Optionality has to earn its place.
   */
  readonly subject: string
  readonly body: string
}

/** Provider acknowledgement. `id` is the provider's own reference, for tracing. */
export type Receipt = { readonly id: string; readonly sentAt: Date }

export type NotifierError =
  | { kind: 'delivery_failed'; reason: string }
  | { kind: 'channel_unsupported'; channel: Channel }

/**
 * FAILURE MODES: delivery can fail, and callers must handle it — an applicant
 * who never receives a code is stuck. No HTTP request can force a provider
 * outage, so these branches are reached in tests by substituting a failing
 * implementation of THIS port, which is the one sanctioned use of substitution
 * (CONVE-16).
 */
export interface Notifier {
  send(message: Message): Promise<Result<Receipt, NotifierError>>
}
