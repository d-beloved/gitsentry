export async function handleGithubAppAuthorization(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const sender = payload.sender as Record<string, unknown>;

  if (action !== "revoked") return;

  // The user has revoked their OAuth grant for this GitHub App.
  // Sessions are JWT-based (stateless) so we can't invalidate them server-side,
  // but we log the event for audit purposes.
  console.log(
    `[github_app_authorization] revoked by github:${sender.id} (${sender.login})`,
  );
}
