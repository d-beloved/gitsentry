const { supabase } = require("../db/client");

async function handleInstallation(payload) {
  const { action, installation, sender, repositories = [] } = payload;
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

    // Seed repos from the installation payload so the dashboard shows them
    // immediately — even before the first scan runs. Repos stay is_active=false
    // until a real scan completes.
    if (repositories.length) {
      const repoRows = repositories.map((r) => ({
        github_id: r.id,
        full_name: r.full_name,
        org_id: org.id,
        installation_id: installation.id,
        is_private: r.private ?? false,
        is_active: false,
      }));

      const { error: repoErr } = await supabase
        .from("repos")
        .upsert(repoRows, { onConflict: "github_id" });

      if (repoErr) throw new Error(`[installation] repo upsert failed: ${repoErr.message}`);
    }

    console.log(
      `[installation] installed on ${account.login} (${account.type}) by github:${sender.id} — install_id=${installation.id}, repos=${repositories.length}`
    );
  }

  if (action === "suspend") {
    const { error: repoErr } = await supabase
      .from("repos")
      .update({ is_active: false })
      .eq("installation_id", installation.id);

    if (repoErr) throw new Error(`[installation] repo deactivation failed: ${repoErr.message}`);

    console.log(`[installation] suspended on ${account.login} — install_id=${installation.id}`);
  }

  if (action === "deleted") {
    // Look up org to find all repos (more reliable than installation_id on repos)
    const { data: orgData } = await supabase
      .from("orgs")
      .select("id")
      .eq("github_id", account.id)
      .single();

    if (orgData) {
      const { data: repoRows } = await supabase
        .from("repos")
        .select("id")
        .eq("org_id", orgData.id);

      if (repoRows?.length) {
        const repoIds = repoRows.map((r) => r.id);

        // Archive anonymized findings to training corpus before deletion.
        // We strip all identifying info (file path, repo/scan links, code snippets)
        // and keep only the vulnerability signal (category, severity, descriptions).
        const { data: findings } = await supabase
          .from("findings")
          .select("severity, category, description, fix_suggestion, is_false_positive, file_path")
          .in("repo_id", repoIds);

        if (findings?.length) {
          const corpusRows = findings.map((f) => ({
            severity: f.severity,
            category: f.category,
            description: f.description,
            fix_suggestion: f.fix_suggestion,
            is_false_positive: f.is_false_positive ?? false,
            language_hint: f.file_path?.split(".").pop()?.toLowerCase() ?? null,
          }));

          const { error: corpusErr } = await supabase
            .from("training_corpus")
            .insert(corpusRows);

          if (corpusErr) {
            // Non-fatal: log and continue with deletion
            console.warn(`[installation] training corpus insert failed: ${corpusErr.message}`);
          } else {
            console.log(`[installation] archived ${corpusRows.length} anonymized findings to training corpus`);
          }
        }

        // Delete repos — CASCADE removes scans and findings
        const { error: repoDelErr } = await supabase
          .from("repos")
          .delete()
          .in("id", repoIds);

        if (repoDelErr) throw new Error(`[installation] repo deletion failed: ${repoDelErr.message}`);
      }
    }

    const { error } = await supabase
      .from("installations")
      .delete()
      .eq("github_install_id", installation.id);

    if (error) throw new Error(`[installation] delete failed: ${error.message}`);

    console.log(
      `[installation] deleted on ${account.login} — all data removed, findings anonymized`
    );
  }
}

module.exports = { handleInstallation };
