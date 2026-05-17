const { supabase } = require("../db/client");

async function handleRepository(payload) {
  const { action, repository: repo } = payload;

  if (action !== "privatized" && action !== "publicized") return;

  const isPrivate = action === "privatized";

  const { error } = await supabase
    .from("repos")
    .update({ is_private: isPrivate })
    .eq("github_id", repo.id);

  if (error) throw new Error(`[repository] ${action} update failed: ${error.message}`);

  console.log(`[repository] ${repo.full_name} marked is_private=${isPrivate} (${action})`);
}

module.exports = { handleRepository };
