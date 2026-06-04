import { supabase } from "../db/client";
import { getOrgByInstallationId } from "../db/queries";
import { setupBranchProtection, removeBranchProtection } from "../lib/github";

export async function handleInstallationRepositories(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const installation = payload.installation as Record<string, unknown>;
  const repositoriesAdded =
    (payload.repositories_added as Array<Record<string, unknown>>) ?? [];
  const repositoriesRemoved =
    (payload.repositories_removed as Array<Record<string, unknown>>) ?? [];

  const installationId = installation.id as number;

  const org = await getOrgByInstallationId(installationId);
  if (!org) {
    console.warn(
      `[installation_repositories] No org found for install_id=${installationId}`,
    );
    return;
  }

  if (action === "added" && repositoriesAdded.length) {
    const repoRows = repositoriesAdded.map((r) => ({
      github_id: r.id,
      full_name: r.full_name,
      org_id: org.id,
      installation_id: installationId,
      is_private: (r.private as boolean) ?? false,
      is_active: false,
      removed_at: null,
    }));

    const { error } = await supabase
      .from("repos")
      .upsert(repoRows, { onConflict: "github_id" });

    if (error)
      throw new Error(`[installation_repositories] add failed: ${error.message}`);

    console.log(
      `[installation_repositories] added ${repositoriesAdded.length} repos to org ${org.id}`,
    );

    if (org.plan === "pro") {
      await Promise.allSettled(
        repositoriesAdded.map((r) =>
          setupBranchProtection(r.full_name as string, "main", installationId).catch(
            (err: Error) =>
              console.error(
                `[installation_repositories] branch protection setup failed for ${r.full_name}:`,
                err.message,
              ),
          ),
        ),
      );
    }
  }

  if (action === "removed" && repositoriesRemoved.length) {
    const githubIds = repositoriesRemoved.map((r) => r.id as number);

    if (org.plan === "pro") {
      const { data: repoDetails } = await supabase
        .from("repos")
        .select("full_name, default_branch")
        .in("github_id", githubIds);

      if (repoDetails?.length) {
        await Promise.allSettled(
          (repoDetails as Array<{ full_name: string; default_branch: string | null }>).map(
            (r) =>
              removeBranchProtection(
                r.full_name,
                r.default_branch ?? "main",
                installationId,
              ).catch((err: Error) =>
                console.error(
                  `[installation_repositories] branch protection removal failed for ${r.full_name}:`,
                  err.message,
                ),
              ),
          ),
        );
      }
    }

    const { error } = await supabase
      .from("repos")
      .update({ is_active: false, removed_at: new Date().toISOString() })
      .in("github_id", githubIds);

    if (error)
      throw new Error(`[installation_repositories] remove failed: ${error.message}`);

    console.log(
      `[installation_repositories] deactivated ${repositoriesRemoved.length} repos from org ${org.id}`,
    );
  }
}
