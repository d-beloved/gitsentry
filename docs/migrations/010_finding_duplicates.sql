-- Migration 010: link a re-detected finding to the one already on record, so the dashboard
-- lists each issue once across parallel PRs and the merge to main. Idempotent.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES findings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_findings_duplicate_of ON findings(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_findings_repo_file    ON findings(repo_id, file_path);
