import type { Message, Notifier, NotifierError, Receipt } from '@/ports/notifier'
import type { Clock } from '@/ports/clock'
import type { IdGenerator } from '@/ports/id-generator'
import { ok, type Result } from '@/shared/result'

/**
 * Implements {@link Notifier} by printing to stdout. Development and tests only.
 *
 * WRAPS: nothing. That is the point — local development needs no mail provider,
 * no API key, and no network. Run `wrangler dev`, request an OTP, read the code
 * out of the terminal.
 *
 * ── WHY THIS EXISTS AS A FIRST-CLASS ADAPTER ────────────────────────────────
 * It is not a stub. It is the reason the Notifier port was drawn where it was:
 * OTP delivery goes through OUR port rather than better-auth's built-in mailer,
 * so the transport is swappable. Console today, Pingram later, one line in the
 * composition root, zero changes to any use-case, route, or test.
 *
 * ── HOW TESTS USE IT ────────────────────────────────────────────────────────
 * `sent` retains recent messages so the test harness can read the OTP code back
 * out. This is the REAL configured adapter being inspected — NOT a substituted
 * port — which is what keeps it inside CONVE-16's rule that port substitution is
 * for failure paths only, never for happy-path convenience.
 *
 * A dev-only "return the last OTP" HTTP endpoint was deliberately NOT built.
 * That is a production incident waiting for one misconfigured environment
 * variable; an in-memory array reachable only from the test process is not.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * This adapter PRINTS LIVE OTP CODES to stdout and delivers nothing. Selecting
 * it in production would silently break signup while leaking credentials into
 * logs. `assertProductionSafety` in config.ts refuses to boot with
 * NOTIFIER_DRIVER=console when ENVIRONMENT=production — the guard is there
 * rather than here because refusing at boot beats failing at first send.
 */

/** Bounded so a long-running dev session cannot grow this without limit. */
const MAX_RETAINED = 100

export type SentMessage = Message & { readonly receipt: Receipt }

export interface ConsoleNotifier extends Notifier {
  /** Messages sent this isolate, oldest first. Read by tests. */
  readonly sent: readonly SentMessage[]
  /** Most recent message to `destination`, or undefined. */
  lastTo(destination: string): SentMessage | undefined
}

export function consoleNotifier(clock: Clock, ids: IdGenerator): ConsoleNotifier {
  const sent: SentMessage[] = []

  return {
    sent,

    async send(message: Message): Promise<Result<Receipt, NotifierError>> {
      const receipt: Receipt = { id: ids.next(), sentAt: clock.now() }

      // eslint-disable-next-line no-console -- writing to stdout IS this adapter's job
      console.log(
        `[notifier:console] ${message.channel} → ${message.destination} | ${message.subject}\n${message.body}`,
      )

      sent.push({ ...message, receipt })
      if (sent.length > MAX_RETAINED) sent.shift()

      return ok(receipt)
    },

    lastTo(destination: string): SentMessage | undefined {
      for (let i = sent.length - 1; i >= 0; i--) {
        if (sent[i]!.destination === destination) return sent[i]
      }
      return undefined
    },
  }
}
