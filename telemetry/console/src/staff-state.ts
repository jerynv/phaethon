import type { AccessChange, StaffMember } from "./api";

/** Owned by the authenticated shell. No staff data survives signing out. */
export type StaffCache = { members: StaffMember[] | null; changes: AccessChange[] | null };
export const createStaffCache = (): StaffCache => ({ members: null, changes: null });
