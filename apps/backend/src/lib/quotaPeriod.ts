/**
 * The single rule that decides which billing period an org's usage counters
 * belong to. Both quota enforcement (try_claim_scan / try_claim_sweep) and the
 * dashboard's "N of M used" read from this, so what we bill and what we show can
 * never drift apart.
 *
 * Keep in sync with apps/web/lib/quota.ts — same rule, mirrored because the web
 * app and the backend do not share a package.
 */

/** Plans whose reset is driven by Paddle's renewal webhook rather than the calendar. */
const PADDLE_BILLED_PLANS = new Set(["starter", "pro"]);

/**
 * How many calendar months an anchor may legitimately lag.
 *
 * A billing period straddles two calendar months: renew on 20 July and you spend
 * the first three weeks of August still inside the July period, so an anchor one
 * month behind is normal. Two months behind means at least one renewal webhook
 * never arrived.
 */
const MAX_ANCHOR_LAG_MONTHS = 1;

export function currentCalendarMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Whole calendar months from one "YYYY-MM" to another. NaN if either is malformed. */
export function monthsBetween(from: string, to: string): number {
  const parse = (m: string): [number, number] | null => {
    const match = /^(\d{4})-(\d{2})$/.exec(m);
    if (!match) return null;
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return [Number(match[1]), month];
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return NaN;
  return (b[0] - a[0]) * 12 + (b[1] - a[1]);
}

export interface QuotaPeriodInput {
  plan: string | null | undefined;
  /** The stored anchor: orgs.scan_month or orgs.sweep_month. */
  anchor: string | null | undefined;
  /** Whether a real Paddle subscription exists — i.e. whether anything will ever reset this org. */
  hasPaddleSubscription: boolean;
  now?: Date;
}

/**
 * The period the org's counters currently belong to. When this differs from the
 * stored anchor, the next claim rolls the counter over to a fresh period.
 *
 *   free                      -> calendar month
 *   paid, no Paddle sub       -> calendar month (comped/dogfood org: nothing else resets it)
 *   paid, no anchor yet       -> calendar month (initialise)
 *   paid, fresh anchor        -> the anchor (Paddle owns the reset)
 *   paid, anchor 2+ mo stale  -> calendar month (renewals stopped arriving)
 *
 * That last branch is a dead-man's switch. Without it a paid org whose webhook
 * stops firing can never reset — the counter climbs to the plan limit and blocks
 * the org permanently, with no code path anywhere able to release it.
 */
export function effectiveQuotaPeriod({
  plan,
  anchor,
  hasPaddleSubscription,
  now,
}: QuotaPeriodInput): string {
  const calendar = currentCalendarMonth(now);

  if (!plan || !PADDLE_BILLED_PLANS.has(plan)) return calendar;
  if (!anchor) return calendar;
  if (!hasPaddleSubscription) return calendar;

  const lag = monthsBetween(anchor, calendar);

  // Malformed anchor: re-anchor to the calendar rather than leave the org stuck
  // on a value nothing can advance. The counter still enforces the limit inside
  // the new period, so this costs at most one period boundary.
  if (Number.isNaN(lag)) return calendar;

  // A future-dated anchor is not a missed renewal, so keep it: returning it
  // unchanged means no reset, which is the fail-closed side of the choice.
  if (lag > MAX_ANCHOR_LAG_MONTHS) return calendar;
  return anchor;
}

/**
 * Usage to display for the period the org is actually in. When the effective
 * period has moved past the stored anchor the counter is a leftover from an
 * expired period and the org's next scan will reset it, so it reads as 0.
 */
export function usageThisPeriod(
  input: QuotaPeriodInput & {count: number | null | undefined},
): number {
  return effectiveQuotaPeriod(input) === input.anchor ? (input.count ?? 0) : 0;
}
