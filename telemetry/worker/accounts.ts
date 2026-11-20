/** Staff account rules shared by the Worker's staff routes and the provisioning CLI. */
export type StaffRole = "owner" | "viewer";

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const MAX_EMAIL_LENGTH = 254;

/** Expects an already trimmed, lower-cased address. */
export function isStaffEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);
}

/** Expects an already trimmed, lower-cased name. */
export function isStaffUsername(username: string): boolean {
  return USERNAME.test(username);
}

/**
 * SQL condition: some active owner other than `idExpression` exists. Writes that could demote or
 * disable an owner include it in their own WHERE clause, so concurrent changes can't race past it.
 */
export function anotherActiveOwner(idExpression: string): string {
  return `EXISTS (SELECT 1 FROM staff other
    WHERE other.role = 'owner' AND other.disabled = 0 AND other.id <> ${idExpression})`;
}
