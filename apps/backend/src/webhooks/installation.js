const { supabase } = require("../db/client");

async function handleInstallation(payload) {
  const { action, installation, sender } = payload;
  const account = installation.account;

  if (action === "created" || action === "unsuspend") {
    const { data: org, error: orgErr } = await supabase
      .from("orgs")
      .upsert(
        {
          github_id: account.id,
          login: account.login,
          avatar_url: account.avatar_url ?? null,
        },
        { onConflict: "github_id" }
      )
      .select("id")
      .single();

    if (orgErr) throw new Error(`[installation] org upsert failed: ${orgErr.message}`);

    const { error: installErr } = await supabase
      .from("installations")
      .upsert(
        {
          github_install_id: installation.id,
          org_id: org.id,
          installer_github_id: sender.id,
        },
        { onConflict: "github_install_id" }
      );

    if (installErr) throw new Error(`[installation] record upsert failed: ${installErr.message}`);

    // Repos are created at scan time (first push/PR), not at installation.
    // The installations record above is sufficient for the dashboard to surface
    // this org's repos once scanning begins.

    console.log(
      `[installation] installed on ${account.login} (${account.type}) by github:${sender.id} — install_id=${installation.id}`
    );
  }

  if (action === "deleted" || action === "suspend") {
    const { error } = await supabase
      .from("installations")
      .delete()
      .eq("github_install_id", installation.id);

    if (error) throw new Error(`[installation] delete failed: ${error.message}`);

    console.log(
      `[installation] removed from ${account.login} — install_id=${installation.id}`
    );
  }
}

module.exports = { handleInstallation };
