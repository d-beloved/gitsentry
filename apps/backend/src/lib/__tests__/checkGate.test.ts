import {hasRequiredCheck} from "../github";

// This predicate decides whether a PR we are not going to scan needs a check run
// to unstick it. Getting it wrong in either direction is a customer-visible bug:
// too narrow leaves a PR blocked on a status that never arrives, too wide invents
// a check on a repo that never had one.
describe("hasRequiredCheck", () => {
  it("admits an active Pro org — the only plan setupBranchProtection runs for", () => {
    expect(hasRequiredCheck({plan: "pro", subscription_status: "active"})).toBe(true);
  });

  it("admits a Pro org with no recorded subscription status", () => {
    // Hand-granted Pro accounts have no Paddle subscription, so a null status is
    // entitled, not lapsed — the same reading the worker's isPro check uses.
    expect(hasRequiredCheck({plan: "pro", subscription_status: null})).toBe(true);
  });

  it("admits a lapsed org, whose branch protection may have outlived the subscription", () => {
    // Paddle sets plan:"free" on lapse and the webhook does try to remove the
    // protection, but best-effort: any repo that removal missed keeps a required
    // check we have stopped feeding. Blocking those merges over an invoice is
    // how you lose the gate — they delete it, or the app.
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
