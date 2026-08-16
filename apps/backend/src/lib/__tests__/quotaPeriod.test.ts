import {effectiveQuotaPeriod, monthsBetween, usageThisPeriod} from "../quotaPeriod";

// Fixed "now" so the tests describe behaviour, not the calendar.
const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("monthsBetween", () => {
  it("counts whole calendar months across a year boundary", () => {
    expect(monthsBetween("2026-08", "2026-08")).toBe(0);
    expect(monthsBetween("2026-07", "2026-08")).toBe(1);
    expect(monthsBetween("2025-11", "2026-02")).toBe(3);
    expect(monthsBetween("2026-09", "2026-08")).toBe(-1);
  });

  it("returns NaN for anything that is not YYYY-MM", () => {
    expect(monthsBetween("2026-13", "2026-08")).toBeNaN();
    expect(monthsBetween("nonsense", "2026-08")).toBeNaN();
    expect(monthsBetween("2026-08", "")).toBeNaN();
  });
});

describe("effectiveQuotaPeriod", () => {
  it("puts free plans on the calendar month regardless of the stored anchor", () => {
    expect(
      effectiveQuotaPeriod({plan: "free", anchor: "2026-06", hasPaddleSubscription: false, now: NOW}),
    ).toBe("2026-08");
  });

  it("keeps a paid org on its anchor while the anchor is current", () => {
    expect(
      effectiveQuotaPeriod({plan: "starter", anchor: "2026-08", hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-08");
  });

  it("keeps a paid org on an anchor one month behind — a billing period straddles two calendar months", () => {
    expect(
      effectiveQuotaPeriod({plan: "pro", anchor: "2026-07", hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-07");
  });

  it("falls back to the calendar once the anchor is two months stale", () => {
    // The dead-man's switch: at least one renewal webhook never arrived, and
    // without this the counter could never reset and would block the org forever.
    expect(
      effectiveQuotaPeriod({plan: "starter", anchor: "2026-06", hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-08");
  });

  it("bills a comped paid plan on the calendar — nothing else would ever reset it", () => {
    expect(
      effectiveQuotaPeriod({plan: "starter", anchor: "2026-06", hasPaddleSubscription: false, now: NOW}),
    ).toBe("2026-08");
  });

  it("initialises a paid org that has no anchor yet", () => {
    expect(
      effectiveQuotaPeriod({plan: "pro", anchor: null, hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-08");
  });

  it("re-anchors a malformed value instead of leaving the org stuck on it", () => {
    expect(
      effectiveQuotaPeriod({plan: "pro", anchor: "june", hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-08");
  });

  it("holds a future-dated anchor rather than granting a reset", () => {
    expect(
      effectiveQuotaPeriod({plan: "pro", anchor: "2026-09", hasPaddleSubscription: true, now: NOW}),
    ).toBe("2026-09");
  });
});

describe("usageThisPeriod", () => {
  it("reports the counter when it belongs to the current period", () => {
    expect(
      usageThisPeriod({
        plan: "starter", anchor: "2026-08", hasPaddleSubscription: true, count: 12, now: NOW,
      }),
    ).toBe(12);
  });

  it("reports 0 when the counter is left over from an expired period", () => {
    // This is what the dashboard got wrong: it showed the stale 50 while the
    // next scan was about to reset the counter to 1.
    expect(
      usageThisPeriod({
        plan: "starter", anchor: "2026-06", hasPaddleSubscription: false, count: 50, now: NOW,
      }),
    ).toBe(0);
  });

  it("treats a missing counter as 0", () => {
    expect(
      usageThisPeriod({
        plan: "free", anchor: "2026-08", hasPaddleSubscription: false, count: null, now: NOW,
      }),
    ).toBe(0);
  });
});
