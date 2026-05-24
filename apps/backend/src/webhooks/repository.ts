import { supabase } from "../db/client";

export async function handleRepository(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string;
  const repo = payload.repository as Record<string, unknown>;

  if (action !== "privatized" && action !== "publicized") return;

  const isPrivate = action === "privatized";

  const { error } = await supabase
    .from("repos")
    .update({ is_private: isPrivate })
    .eq("github_id", repo.id);

  if (error) throw new Error(`[repository] ${action} update failed: ${error.message}`);

  console.log(`[repository] ${repo.full_name} marked is_private=${isPrivate} (${action})`);
}
