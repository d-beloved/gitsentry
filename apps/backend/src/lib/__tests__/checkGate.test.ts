import {hasRequiredCheck} from "../github";

// Too narrow leaves an unscanned PR blocked on a check that never arrives;
// too wide invents a check on a repo that never had one.
describe("hasRequiredCheck", () => {
  it("admits an active Pro org — the only plan setupBranchProtection runs for", () => {
    expect(hasRequiredCheck({plan: "pro", subscription_status: "active"})).toBe(true);
  });

  it("admits a Pro org with no recorded subscription status", () => {
    // Hand-granted Pro accounts have no subscription; null means entitled, not lapsed.
    expect(hasRequiredCheck({plan: "pro", subscription_status: null})).toBe(true);
  });

  it("admits a lapsed org, whose branch protection may have outlived the subscription", () => {
    // Protection removal on lapse is best-effort, so a missed repo still requires
    // a check we no longer feed.
    for (const status of ["canceled", "past_due", "payment_failed"]) {
      expect(hasRequiredCheck({plan: "free", subscription_status: status})).toBe(true);
    }
  });

  it("rejects plans that never had the check set up", () => {
    expect(hasRequiredCheck({plan: "free", subscription_status: "active"})).toBe(false);
    expect(hasRequiredCheck({plan: "starter", subscription_status: "active"})).toBe(false);
    expect(hasRequiredCheck({plan: "free", subscription_status: null})).toBe(false);
  });

  it("rejects a missing org", () => {
    expect(hasRequiredCheck(null)).toBe(false);
  });
});
