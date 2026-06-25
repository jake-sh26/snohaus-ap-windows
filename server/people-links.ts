/**
 * PR #201 — Manual relink operations for employee ↔ user ↔ person.
 *
 * The PR #200 backfill links every employee to a person and tries to match
 * users to employees by email. When the email heuristic fails (different
 * addresses, ambiguous shared mailbox, employee with no email) the user ends
 * up on its own person row and there's no UI to fix it. This module exposes
 * the operations the Settings UI needs to override those decisions by hand:
 *
 *   linkUserToEmployee(userId, employeeId)
 *     - point user.person_id at employee.person_id
 *     - archive the user's previous person row if nothing else points to it
 *
 *   linkEmployeeToUser(employeeId, userId)
 *     - mirror operation initiated from the Employees page
 *
 *   unlinkUser(userId)   /  unlinkEmployee(employeeId)
 *     - sever the link by creating a fresh person row for that side
 *     - archive the previously-shared person row if it ends up orphaned
 *
 * All operations:
 *   - Run inside a single transaction.
 *   - Use the "block on conflict" rule: if the target side is already linked
 *     to a third party, throw ConflictError instead of stealing. The caller
 *     (the route handler) maps that to HTTP 409.
 *   - Archive — not delete — orphan persons. status='archived' is reversible;
 *     external_ids stay attached for audit. The next backfill skips archived
 *     persons because the user/employee is no longer NULL.
 */

import { sqlite } from "./storage";
import { archivePerson, createPerson } from "./people";

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

interface EmployeeRow {
  id: number;
  full_name: string | null;
  email: string | null;
  person_id: number | null;
}

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  person_id: number | null;
}

function getEmployee(id: number): EmployeeRow | undefined {
  return sqlite
    .prepare(`SELECT id, full_name, email, person_id FROM payroll_employees WHERE id = ?`)
    .get(id) as EmployeeRow | undefined;
}

function getUser(id: number): UserRow | undefined {
  return sqlite
    .prepare(`SELECT id, email, name, person_id FROM app_users WHERE id = ?`)
    .get(id) as UserRow | undefined;
}

/**
 * Returns true iff anything other than `excludeUserId`/`excludeEmployeeId`
 * still references this person. Used to decide whether to archive the orphan.
 */
function personStillReferenced(
  personId: number,
  excludeUserId: number | null,
  excludeEmployeeId: number | null,
): boolean {
  const userCount = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM app_users WHERE person_id = ?` +
        (excludeUserId != null ? ` AND id != ?` : ``),
    )
    .get(
      ...(excludeUserId != null ? [personId, excludeUserId] : [personId]),
    ) as { n: number };
  if (userCount.n > 0) return true;

  const empCount = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM payroll_employees WHERE person_id = ?` +
        (excludeEmployeeId != null ? ` AND id != ?` : ``),
    )
    .get(
      ...(excludeEmployeeId != null ? [personId, excludeEmployeeId] : [personId]),
    ) as { n: number };
  return empCount.n > 0;
}

/**
 * Archive `personId` if no employee or user (other than the explicit excludes)
 * still references it. No-op otherwise.
 */
function archiveIfOrphaned(
  personId: number,
  excludeUserId: number | null,
  excludeEmployeeId: number | null,
): boolean {
  if (personStillReferenced(personId, excludeUserId, excludeEmployeeId)) return false;
  archivePerson(personId);
  return true;
}

/**
 * Link a user to a specific employee's person. The user's previous person
 * is archived if no one else points to it.
 *
 * Throws ConflictError if the employee is already linked to a *different*
 * user — caller must unlink that user first.
 */
export function linkUserToEmployee(
  userId: number,
  employeeId: number,
): { user_id: number; employee_id: number; person_id: number; archived_person_id: number | null } {
  return sqlite.transaction(() => {
    const user = getUser(userId);
    if (!user) throw new NotFoundError(`User ${userId} not found`);
    const employee = getEmployee(employeeId);
    if (!employee) throw new NotFoundError(`Employee ${employeeId} not found`);
    if (employee.person_id == null) {
      // Shouldn't happen post-backfill, but defensive: every employee should
      // have a person_id after PR #200 runs.
      throw new NotFoundError(
        `Employee ${employeeId} has no person_id yet — backfill may not have run`,
      );
    }

    // Conflict: is this employee's person already claimed by some OTHER user?
    const conflict = sqlite
      .prepare(
        `SELECT id, email FROM app_users
          WHERE person_id = ? AND id != ?
          LIMIT 1`,
      )
      .get(employee.person_id, userId) as { id: number; email: string } | undefined;
    if (conflict) {
      throw new ConflictError(
        `${employee.full_name || `Employee ${employeeId}`} is already linked to user ${conflict.email} (user id ${conflict.id}). Unlink that user first, then try again.`,
      );
    }

    // No-op if already linked correctly.
    if (user.person_id === employee.person_id) {
      return {
        user_id: userId,
        employee_id: employeeId,
        person_id: employee.person_id,
        archived_person_id: null,
      };
    }

    const previousPersonId = user.person_id;
    sqlite
      .prepare(`UPDATE app_users SET person_id = ? WHERE id = ?`)
      .run(employee.person_id, userId);

    let archived: number | null = null;
    if (previousPersonId != null && previousPersonId !== employee.person_id) {
      if (archiveIfOrphaned(previousPersonId, userId, null)) {
        archived = previousPersonId;
      }
    }

    return {
      user_id: userId,
      employee_id: employeeId,
      person_id: employee.person_id,
      archived_person_id: archived,
    };
  })();
}

/**
 * Symmetric op initiated from the Employees page: link an employee's person
 * to a specific user. The employee's previous person is archived if orphaned.
 *
 * Throws ConflictError if the user is already linked to a different employee.
 */
export function linkEmployeeToUser(
  employeeId: number,
  userId: number,
): { employee_id: number; user_id: number; person_id: number; archived_person_id: number | null } {
  return sqlite.transaction(() => {
    const employee = getEmployee(employeeId);
    if (!employee) throw new NotFoundError(`Employee ${employeeId} not found`);
    const user = getUser(userId);
    if (!user) throw new NotFoundError(`User ${userId} not found`);
    if (user.person_id == null) {
      // Defensive — backfill should always create a person for every user.
      throw new NotFoundError(
        `User ${userId} has no person_id yet — backfill may not have run`,
      );
    }

    // Conflict: is this user's person already claimed by some OTHER employee?
    const conflict = sqlite
      .prepare(
        `SELECT id, full_name FROM payroll_employees
          WHERE person_id = ? AND id != ?
          LIMIT 1`,
      )
      .get(user.person_id, employeeId) as
      | { id: number; full_name: string | null }
      | undefined;
    if (conflict) {
      throw new ConflictError(
        `${user.email} is already linked to employee ${conflict.full_name || `#${conflict.id}`} (employee id ${conflict.id}). Unlink that employee first, then try again.`,
      );
    }

    if (employee.person_id === user.person_id) {
      return {
        employee_id: employeeId,
        user_id: userId,
        person_id: user.person_id,
        archived_person_id: null,
      };
    }

    const previousPersonId = employee.person_id;
    sqlite
      .prepare(`UPDATE payroll_employees SET person_id = ? WHERE id = ?`)
      .run(user.person_id, employeeId);

    let archived: number | null = null;
    if (previousPersonId != null && previousPersonId !== user.person_id) {
      if (archiveIfOrphaned(previousPersonId, null, employeeId)) {
        archived = previousPersonId;
      }
    }

    return {
      employee_id: employeeId,
      user_id: userId,
      person_id: user.person_id,
      archived_person_id: archived,
    };
  })();
}

/**
 * Sever a user from a shared person. The user gets a fresh person row; the
 * old shared person stays attached to the employee (or becomes archived if
 * the employee side is also gone, though in practice the employee side stays).
 */
export function unlinkUser(
  userId: number,
): { user_id: number; new_person_id: number; archived_person_id: number | null } {
  return sqlite.transaction(() => {
    const user = getUser(userId);
    if (!user) throw new NotFoundError(`User ${userId} not found`);

    const previousPersonId = user.person_id;
    const display = user.name?.trim() || user.email.split("@")[0];
    const fresh = createPerson({ display_name: display });
    sqlite
      .prepare(`UPDATE app_users SET person_id = ? WHERE id = ?`)
      .run(fresh.id, userId);

    let archived: number | null = null;
    if (previousPersonId != null && previousPersonId !== fresh.id) {
      if (archiveIfOrphaned(previousPersonId, userId, null)) {
        archived = previousPersonId;
      }
    }

    return {
      user_id: userId,
      new_person_id: fresh.id,
      archived_person_id: archived,
    };
  })();
}

/**
 * Sever an employee from a shared person. Mirror of unlinkUser.
 */
export function unlinkEmployee(
  employeeId: number,
): { employee_id: number; new_person_id: number; archived_person_id: number | null } {
  return sqlite.transaction(() => {
    const employee = getEmployee(employeeId);
    if (!employee) throw new NotFoundError(`Employee ${employeeId} not found`);

    const previousPersonId = employee.person_id;
    const display = employee.full_name?.trim() || `Employee ${employeeId}`;
    const fresh = createPerson({ display_name: display });
    sqlite
      .prepare(`UPDATE payroll_employees SET person_id = ? WHERE id = ?`)
      .run(fresh.id, employeeId);

    let archived: number | null = null;
    if (previousPersonId != null && previousPersonId !== fresh.id) {
      if (archiveIfOrphaned(previousPersonId, null, employeeId)) {
        archived = previousPersonId;
      }
    }

    return {
      employee_id: employeeId,
      new_person_id: fresh.id,
      archived_person_id: archived,
    };
  })();
}

/**
 * Resolves the current link state for the Settings UI table.
 * One row per user, with the matching employee (if any) joined via person_id.
 */
export interface UserWithLink {
  user_id: number;
  user_email: string;
  user_name: string | null;
  person_id: number | null;
  linked_employee_id: number | null;
  linked_employee_name: string | null;
  linked_employee_email: string | null;
}

export function listUsersWithLinks(): UserWithLink[] {
  return sqlite
    .prepare(
      `SELECT u.id AS user_id,
              u.email AS user_email,
              u.name AS user_name,
              u.person_id AS person_id,
              e.id AS linked_employee_id,
              e.full_name AS linked_employee_name,
              e.email AS linked_employee_email
         FROM app_users u
    LEFT JOIN payroll_employees e ON e.person_id = u.person_id
        ORDER BY u.email ASC`,
    )
    .all() as UserWithLink[];
}

export interface EmployeeWithLink {
  employee_id: number;
  employee_name: string | null;
  employee_email: string | null;
  person_id: number | null;
  linked_user_id: number | null;
  linked_user_email: string | null;
  linked_user_name: string | null;
}

export function listEmployeesWithLinks(): EmployeeWithLink[] {
  return sqlite
    .prepare(
      `SELECT e.id AS employee_id,
              e.full_name AS employee_name,
              e.email AS employee_email,
              e.person_id AS person_id,
              u.id AS linked_user_id,
              u.email AS linked_user_email,
              u.name AS linked_user_name
         FROM payroll_employees e
    LEFT JOIN app_users u ON u.person_id = e.person_id
        ORDER BY e.full_name ASC`,
    )
    .all() as EmployeeWithLink[];
}
