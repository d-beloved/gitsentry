export async function handleGithubAppAuthorization(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const sender = payload.sender as Record<string, unknown>;

  if (action !== "revoked") return;

  // Sessions are stateless JWTs and can't be invalidated server-side; log for audit.
  console.log(
    `[github_app_authorization] revoked by github:${sender.id} (${sender.login})`,
  );
}
