import { supabase } from "../db/client";
import { getOrgByInstallationId } from "../db/queries";

export async function handleInstallationRepositories(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const installation = payload.installation as Record<string, unknown>;
  const repositoriesAdded =
    (payload.repositories_added as Array<Record<string, unknown>>) ?? [];
  const repositoriesRemoved =
    (payload.repositories_removed as Array<Record<string, unknown>>) ?? [];

  const org = await getOrgByInstallationId(installation.id as number);
  if (!org) {
    console.warn(
      `[installation_repositories] No org found for install_id=${installation.id}`,
    );
    return;
  }

  if (action === "added" && repositoriesAdded.length) {
    const repoRows = repositoriesAdded.map((r) => ({
      github_id: r.id,
      full_name: r.full_name,
      org_id: org.id,
      installation_id: installation.id,
      is_private: (r.private as boolean) ?? false,
      is_active: false,
    }));

    const { error } = await supabase
      .from("repos")
      .upsert(repoRows, { onConflict: "github_id" });

    if (error)
      throw new Error(`[installation_repositories] add failed: ${error.message}`);
    console.log(
      `[installation_repositories] added ${repositoriesAdded.length} repos to org ${org.id}`,
    );
  }

  if (action === "removed" && repositoriesRemoved.length) {
    const githubIds = repositoriesRemoved.map((r) => r.id);

    const { error } = await supabase
      .from("repos")
      .update({ is_active: false })
      .in("github_id", githubIds);

    if (error)
      throw new Error(`[installation_repositories] remove failed: ${error.message}`);
    console.log(
      `[installation_repositories] deactivated ${repositoriesRemoved.length} repos from org ${org.id}`,
    );
  }
}
