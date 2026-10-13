// Billing-period rule shared by quota enforcement and the dashboard.
// Keep in sync with apps/web/lib/quota.ts.

/** Reset by Paddle's renewal webhook rather than the calendar. */
const PADDLE_BILLED_PLANS = new Set(["starter", "pro"]);

// A period straddles two calendar months, so one month of lag is normal;
// two means a renewal webhook never arrived.
const MAX_ANCHOR_LAG_MONTHS = 1;

export function currentCalendarMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Whole months between two "YYYY-MM" strings; NaN if either is malformed. */
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
  /** orgs.scan_month or orgs.sweep_month. */
  anchor: string | null | undefined;
  /** Without one, nothing but the calendar will ever reset this org. */
  hasPaddleSubscription: boolean;
  now?: Date;
}

/** Calendar month unless a fresh Paddle anchor exists; a stale anchor falls back so a lost webhook can't block an org forever. */
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

  // Malformed anchor: re-anchor rather than leave the org stuck on it.
  if (Number.isNaN(lag)) return calendar;

  // A future-dated anchor is kept (no reset), which fails closed.
  if (lag > MAX_ANCHOR_LAG_MONTHS) return calendar;
  return anchor;
}

/** Reads 0 when the stored counter belongs to an expired period. */
export function usageThisPeriod(
  input: QuotaPeriodInput & {count: number | null | undefined},
): number {
  return effectiveQuotaPeriod(input) === input.anchor ? (input.count ?? 0) : 0;
}
