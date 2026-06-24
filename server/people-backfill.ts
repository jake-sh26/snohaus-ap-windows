/**
 * One-time backfill that wires existing payroll_employees and app_users rows
 * to the canonical people table (PR #200, follows the schema foundation in
 * PR #199).
 *
 * Strategy
 * --------
 * Runs once on every server boot via bootstrapSchema(). Each pass is
 * idempotent — only rows with person_id IS NULL are touched. Three steps:
 *
 *   1) For every employee with no person_id:
 *        - create a people row using full_name as display_name
 *        - link the employee to that person via
 *            UPDATE payroll_employees SET person_id = ?
 *        - register every third-party id the employee row already holds in
 *          person_external_ids (adp_employee_id, shopify_staff_member_id,
 *          easyrent_clerk_guid, ltm_clerk_id). Empty/null values skipped.
 *
 *   2) For every app_user with no person_id:
 *        - try CONSERVATIVE email match against payroll_employees.email
 *          (case-insensitive, trimmed). If a single confident match: reuse
 *          that employee's person_id.
 *        - otherwise create a new people row using the user's name (or email
 *          local-part) as display_name.
 *
 *   3) Log the unmatched user-only people (where no employee email matched)
 *      so the operator can reconcile manually if needed. Unmatched is normal
 *      for the foreseeable future — most floor staff won't have logins, most
 *      logins won't have payroll rows.
 *
 * Safety properties
 * -----------------
 *   - Wrapped in a single transaction so a mid-flight crash doesn't leave
 *     half-linked rows.
 *   - Idempotent: rerunning is a no-op because the WHERE clauses filter on
 *     person_id IS NULL.
 *   - Conflict handling: if attachExternalId throws (two employees share the
 *     same Shopify GID, say), the whole row is skipped and the conflict is
 *     logged. The employee still gets a person_id, just without that ID
 *     registered — the operator can fix it via the upcoming UI.
 */
import { sqlite } from "./storage";
import { createPerson, attachExternalId, PERSON_SYSTEMS } from "./people";

interface EmployeeRow {
  id: number;
  full_name: string | null;
  email: string | null;
  adp_employee_id: string | null;
  shopify_staff_member_id: string | null;
  easyrent_clerk_guid: string | null;
  ltm_clerk_id: string | null;
}

interface UserRow {
  id: number;
  email: string;
  name: string | null;
}

export interface PeopleBackfillResult {
  employees_linked: number;
  users_linked_to_existing_employee: number;
  users_linked_new_person: number;
  external_ids_attached: number;
  external_id_conflicts: Array<{
    employee_id: number;
    system: string;
    external_id: string;
    error: string;
  }>;
}

/**
 * Runs the backfill. Safe to call repeatedly — only operates on rows where
 * person_id IS NULL. Returns a summary for logging.
 */
export function runPeopleBackfill(): PeopleBackfillResult {
  const result: PeopleBackfillResult = {
    employees_linked: 0,
    users_linked_to_existing_employee: 0,
    users_linked_new_person: 0,
    external_ids_attached: 0,
    external_id_conflicts: [],
  };

  // Defensive: bail cleanly if the columns don't exist yet. This module runs
  // *after* ensureColumns in bootstrapSchema, so they should always exist,
  // but a defensive check costs nothing and avoids a confusing UPDATE error.
  if (!hasColumn("payroll_employees", "person_id") || !hasColumn("app_users", "person_id")) {
    console.warn("[people-backfill] skipping — person_id column not present yet");
    return result;
  }

  const tx = sqlite.transaction(() => {
    // ---- Step 1: link employees ----
    const unlinkedEmployees = sqlite
      .prepare(
        `SELECT id, full_name, email, adp_employee_id, shopify_staff_member_id,
                easyrent_clerk_guid, ltm_clerk_id
           FROM payroll_employees
          WHERE person_id IS NULL
          ORDER BY id ASC`,
      )
      .all() as EmployeeRow[];

    const linkEmployee = sqlite.prepare(
      `UPDATE payroll_employees SET person_id = ? WHERE id = ?`,
    );

    for (const emp of unlinkedEmployees) {
      const person = createPerson({
        display_name: emp.full_name || `Employee ${emp.id}`,
      });
      linkEmployee.run(person.id, emp.id);
      result.employees_linked += 1;

      // Attach each third-party id the employee row already holds.
      const attachments: Array<{ system: string; external_id: string | null }> = [
        { system: PERSON_SYSTEMS.ADP, external_id: emp.adp_employee_id },
        { system: PERSON_SYSTEMS.SHOPIFY_STAFF, external_id: emp.shopify_staff_member_id },
        { system: "easyrent_clerk", external_id: emp.easyrent_clerk_guid },
        { system: "ltm_clerk", external_id: emp.ltm_clerk_id },
      ];
      for (const a of attachments) {
        if (!a.external_id || a.external_id.trim() === "") continue;
        try {
          attachExternalId({
            person_id: person.id,
            system: a.system,
            external_id: a.external_id.trim(),
            label: "backfill from payroll_employees",
          });
          result.external_ids_attached += 1;
        } catch (e: any) {
          // Conflict (two employees share the same third-party id). Log it,
          // keep the person linkage, move on — the operator can resolve via
          // the upcoming UI.
          result.external_id_conflicts.push({
            employee_id: emp.id,
            system: a.system,
            external_id: a.external_id,
            error: e?.message || String(e),
          });
        }
      }
    }

    // ---- Step 2: link users ----
    const unlinkedUsers = sqlite
      .prepare(`SELECT id, email, name FROM app_users WHERE person_id IS NULL ORDER BY id ASC`)
      .all() as UserRow[];

    // Pre-build the employee-by-email lookup once. Lowercased + trimmed for
    // the conservative match. If multiple employees share an email (shouldn't
    // happen but be defensive) we treat it as ambiguous and skip the match.
    const employeeByEmail = new Map<string, number | "AMBIGUOUS">();
    const allEmployees = sqlite
      .prepare(
        `SELECT id, email FROM payroll_employees
          WHERE email IS NOT NULL AND TRIM(email) != ''`,
      )
      .all() as Array<{ id: number; email: string }>;
    for (const e of allEmployees) {
      const key = e.email.trim().toLowerCase();
      const existing = employeeByEmail.get(key);
      if (existing === undefined) employeeByEmail.set(key, e.id);
      else if (existing !== "AMBIGUOUS") employeeByEmail.set(key, "AMBIGUOUS");
    }

    const getEmployeePersonId = sqlite.prepare(
      `SELECT person_id FROM payroll_employees WHERE id = ?`,
    );
    const linkUser = sqlite.prepare(`UPDATE app_users SET person_id = ? WHERE id = ?`);

    for (const user of unlinkedUsers) {
      const key = user.email.trim().toLowerCase();
      const match = employeeByEmail.get(key);
      if (match !== undefined && match !== "AMBIGUOUS") {
        const empRow = getEmployeePersonId.get(match) as
          | { person_id: number | null }
          | undefined;
        if (empRow?.person_id) {
          linkUser.run(empRow.person_id, user.id);
          result.users_linked_to_existing_employee += 1;
          continue;
        }
      }
      // No confident employee match — create a fresh person for the user.
      const display = user.name?.trim() || user.email.split("@")[0];
      const person = createPerson({ display_name: display });
      linkUser.run(person.id, user.id);
      result.users_linked_new_person += 1;
    }
  });

  tx();
  return result;
}

function hasColumn(table: string, col: string): boolean {
  const cols = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}
