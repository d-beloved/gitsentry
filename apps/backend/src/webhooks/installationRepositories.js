const { supabase } = require("../db/client");
const { getOrgByInstallationId } = require("../db/queries");

async function handleInstallationRepositories(payload) {
  const { action, installation, repositories_added = [], repositories_removed = [] } = payload;

  const org = await getOrgByInstallationId(installation.id);
  if (!org) {
    console.warn(`[installation_repositories] No org found for install_id=${installation.id}`);
    return;
  }

  if (action === "added" && repositories_added.length) {
    const repoRows = repositories_added.map((r) => ({
      github_id: r.id,
      full_name: r.full_name,
      org_id: org.id,
      installation_id: installation.id,
      is_private: r.private ?? false,
      is_active: false,
    }));

    const { error } = await supabase
      .from("repos")
      .upsert(repoRows, { onConflict: "github_id" });

    if (error) throw new Error(`[installation_repositories] add failed: ${error.message}`);
    console.log(`[installation_repositories] added ${repositories_added.length} repos to org ${org.id}`);
  }

  if (action === "removed" && repositories_removed.length) {
    const githubIds = repositories_removed.map((r) => r.id);

    const { error } = await supabase
      .from("repos")
      .update({ is_active: false })
      .in("github_id", githubIds);

    if (error) throw new Error(`[installation_repositories] remove failed: ${error.message}`);
    console.log(`[installation_repositories] deactivated ${repositories_removed.length} repos from org ${org.id}`);
  }
}

module.exports = { handleInstallationRepositories };
