async function handleGithubAppAuthorization(payload) {
  const { action, sender } = payload;

  if (action !== "revoked") return;

  // The user has revoked their OAuth grant for this GitHub App.
  // Sessions are JWT-based (stateless) so we can't invalidate them server-side,
  // but we log the event for audit purposes. If token storage is added later,
  // delete it here.
  console.log(`[github_app_authorization] revoked by github:${sender.id} (${sender.login})`);
}

module.exports = { handleGithubAppAuthorization };
