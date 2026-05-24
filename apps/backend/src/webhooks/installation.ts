import { supabase } from "../db/client";

export async function handleInstallation(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const installation = payload.installation as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;
  const repositories = (payload.repositories as Array<Record<string, unknown>>) ?? [];
  const account = installation.account as Record<string, unknown>;

  if (action === "created" || action === "unsuspend") {
    const { data: org, error: orgErr } = await supabase
      .from("orgs")
      .upsert(
        {
          github_id: account.id,
          login: account.login,
          avatar_url: (account.avatar_url as string | null) ?? null,
        },
        { onConflict: "github_id" },
      )
      .select("id")
      .single();

    if (orgErr) throw new Error(`[installation] org upsert failed: ${orgErr.message}`);

    const { error: installErr } = await supabase
      .from("installations")
      .upsert(
        {
          github_install_id: installation.id,
          org_id: (org as { id: string }).id,
          installer_github_id: sender.id,
        },
        { onConflict: "github_install_id" },
      );

    if (installErr)
      throw new Error(`[installation] record upsert failed: ${installErr.message}`);

    if (repositories.length) {
      const repoRows = repositories.map((r) => ({
        github_id: r.id,
        full_name: r.full_name,
        org_id: (org as { id: string }).id,
        installation_id: installation.id,
        is_private: (r.private as boolean) ?? false,
        is_active: false,
      }));

      const { error: repoErr } = await supabase
        .from("repos")
        .upsert(repoRows, { onConflict: "github_id" });

      if (repoErr)
        throw new Error(`[installation] repo upsert failed: ${repoErr.message}`);
    }

    console.log(
      `[installation] installed on ${account.login} (${account.type}) by github:${sender.id} — install_id=${installation.id}, repos=${repositories.length}`,
    );
  }

  if (action === "suspend") {
    const { error: repoErr } = await supabase
      .from("repos")
      .update({ is_active: false })
      .eq("installation_id", installation.id);

    if (repoErr)
      throw new Error(`[installation] repo deactivation failed: ${repoErr.message}`);

    console.log(
      `[installation] suspended on ${account.login} — install_id=${installation.id}`,
    );
  }

  if (action === "deleted") {
    const { data: orgData } = await supabase
      .from("orgs")
      .select("id")
      .eq("github_id", account.id)
      .single();

    if (orgData) {
      const { data: repoRows } = await supabase
        .from("repos")
        .select("id")
        .eq("org_id", (orgData as { id: string }).id);

      if (repoRows?.length) {
        const repoIds = (repoRows as Array<{ id: string }>).map((r) => r.id);

        // Archive anonymized findings to training corpus before deletion.
        // We strip all identifying info and keep only the vulnerability signal.
        const { data: findings } = await supabase
          .from("findings")
          .select(
            "severity, category, description, fix_suggestion, is_false_positive, file_path",
          )
          .in("repo_id", repoIds);

        if (findings?.length) {
          const corpusRows = (
            findings as Array<{
              severity: string;
              category: string;
              description: string;
              fix_suggestion: string;
              is_false_positive: boolean | null;
              file_path: string | null;
            }>
          ).map((f) => ({
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
            console.warn(
              `[installation] training corpus insert failed: ${corpusErr.message}`,
            );
          } else {
            console.log(
              `[installation] archived ${corpusRows.length} anonymized findings to training corpus`,
            );
          }
        }

        const { error: repoDelErr } = await supabase
          .from("repos")
          .delete()
          .in("id", repoIds);

        if (repoDelErr)
          throw new Error(`[installation] repo deletion failed: ${repoDelErr.message}`);
      }
    }

    const { error } = await supabase
      .from("installations")
      .delete()
      .eq("github_install_id", installation.id);

    if (error) throw new Error(`[installation] delete failed: ${error.message}`);

    console.log(
      `[installation] deleted on ${account.login} — all data removed, findings anonymized`,
    );
  }
}
