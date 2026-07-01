-- Dedupe user_roles: collapse identical (user_id, role_id, entity_id_scope) triples
-- to a single row. Historical duplicates (Jake's Owner assignment has 256 dupes)
-- exist due to a bug where the assignment upsert didn't dedupe on save.
BEGIN TRANSACTION;

CREATE TEMPORARY TABLE _user_roles_dedup AS
  SELECT MIN(id) AS keep_id, user_id, role_id, entity_id_scope
  FROM user_roles
  GROUP BY user_id, role_id, entity_id_scope;

DELETE FROM user_roles
  WHERE id NOT IN (SELECT keep_id FROM _user_roles_dedup);

DROP TABLE _user_roles_dedup;

COMMIT;

-- Prevent future duplicates: partial unique index treating NULL as a value
-- (SQLite treats NULLs as distinct in UNIQUE by default, so use COALESCE trick)
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_roles_no_dupes
  ON user_roles (user_id, role_id, COALESCE(entity_id_scope, -1));
