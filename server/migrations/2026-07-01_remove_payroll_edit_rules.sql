-- Remove the orphaned payroll.edit_rules permission.
--
-- payroll.edit_rules never had a route enforcing it (grep of server/routes.ts
-- returns zero hits) and its intent is now covered by payroll.edit_commissions.
-- The boot-time seeder (seedRbacBaseline in server/storage.ts) upserts
-- PERMISSION_CATALOG but never prunes removed keys, so dropping it from the
-- catalog leaves a stale permissions row in existing DBs. This migration
-- deletes that row and any role_permissions assignments referencing it.
--
-- Schema note: role_permissions references permissions(id) via permission_id
-- (ON DELETE CASCADE), so the second DELETE alone would suffice — but we clear
-- role_permissions explicitly first to be safe against DBs where the FK
-- cascade is not enforced (PRAGMA foreign_keys can be OFF).
BEGIN TRANSACTION;

DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'payroll.edit_rules');

DELETE FROM permissions
  WHERE key = 'payroll.edit_rules';

COMMIT;
