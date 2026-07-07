import { isDependencyBot, isReleaseAutomationPR } from "../botDetection";

describe("isDependencyBot", () => {
  it("matches known dependency bot logins", () => {
    expect(isDependencyBot("dependabot[bot]")).toBe(true);
    expect(isDependencyBot("renovate[bot]")).toBe(true);
    expect(isDependencyBot("snyk-bot")).toBe(true);
  });

  it("matches prefixed variants case-insensitively", () => {
    expect(isDependencyBot("Dependabot-Preview[bot]")).toBe(true);
    expect(isDependencyBot("renovate-approve[bot]")).toBe(true);
  });

  it("does not match humans or undefined", () => {
    expect(isDependencyBot("octocat")).toBe(false);
    expect(isDependencyBot(undefined)).toBe(false);
  });
});

describe("isReleaseAutomationPR", () => {
  it("matches release bot app logins regardless of other signals", () => {
    expect(isReleaseAutomationPR({ login: "release-please[bot]" })).toBe(true);
    expect(isReleaseAutomationPR({ login: "changesets-release[bot]" })).toBe(true);
    expect(isReleaseAutomationPR({ login: "semantic-release-bot" })).toBe(true);
  });

  it("matches release-please run as a GitHub Actions workflow (github-actions[bot] author)", () => {
    expect(
      isReleaseAutomationPR({
        login: "github-actions[bot]",
        isBotAuthor: true,
        headRef: "release-please--branches--main",
        title: "chore(main): release 1.4.0",
      }),
    ).toBe(true);
  });

  it("matches release-please by head branch alone", () => {
    expect(
      isReleaseAutomationPR({
        login: "github-actions[bot]",
        isBotAuthor: true,
        headRef: "release-please--branches--main--components--api",
      }),
    ).toBe(true);
    expect(
      isReleaseAutomationPR({ headRef: "release-please/branches/main" }),
    ).toBe(true);
  });

  it("matches changesets action by head branch and title", () => {
    expect(
      isReleaseAutomationPR({
        login: "github-actions[bot]",
        isBotAuthor: true,
        headRef: "changeset-release/main",
        title: "Version Packages",
      }),
    ).toBe(true);
  });

  it("matches bot-authored release titles even on custom branches", () => {
    expect(
      isReleaseAutomationPR({
        login: "github-actions[bot]",
        isBotAuthor: true,
        headRef: "automation/bump",
        title: "chore: release 2.0.0",
      }),
    ).toBe(true);
  });

  it("does NOT match a human PR with a release-ish title", () => {
    expect(
      isReleaseAutomationPR({
        login: "octocat",
        isBotAuthor: false,
        headRef: "feat/release-notes-page",
        title: "chore: release checklist page",
      }),
    ).toBe(false);
  });

  it("does NOT match ordinary github-actions[bot] code PRs", () => {
    expect(
      isReleaseAutomationPR({
        login: "github-actions[bot]",
        isBotAuthor: true,
        headRef: "auto-fix/lint",
        title: "fix: apply eslint autofixes",
      }),
    ).toBe(false);
  });

  it("does NOT match human feature branches", () => {
    expect(
      isReleaseAutomationPR({
        login: "octocat",
        isBotAuthor: false,
        headRef: "release/v2-launch-page",
        title: "Add v2 launch page",
      }),
    ).toBe(false);
  });
});
