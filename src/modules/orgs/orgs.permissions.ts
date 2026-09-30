// Who may do what inside an organization. Pure functions so the rules are
// easy to read and test in one place; the controller enforces them.

export type OrgRole = "owner" | "admin" | "member" | "billing";
export type InvitableRole = "admin" | "member";

export function isOrgRole(value: unknown): value is OrgRole {
  return value === "owner" || value === "admin" || value === "member" || value === "billing";
}

/** Admins run the org day to day; the owner additionally controls roles. */
export function isAdmin(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

export function canManageOrg(actor: OrgRole): boolean {
  return isAdmin(actor);
}

/** Admins may invite members; only the owner may invite (i.e. create) admins. */
export function canInvite(actor: OrgRole, inviteRole: InvitableRole): boolean {
  if (inviteRole === "admin") return actor === "owner";
  return isAdmin(actor);
}

/** Only the owner changes roles, never their own, and never to/from owner (no transfers yet). */
export function canChangeRole(
  actor: OrgRole,
  actorId: string,
  target: { accountId: string; role: OrgRole },
  newRole: OrgRole
): boolean {
  if (actor !== "owner") return false;
  if (target.accountId === actorId) return false;
  if (target.role === "owner" || newRole === "owner") return false;
  return true;
}

/** The owner can't be removed; admins can remove members but only the owner can remove admins. */
export function canRemoveMember(
  actor: OrgRole,
  actorId: string,
  target: { accountId: string; role: OrgRole }
): boolean {
  if (target.accountId === actorId) return false; // use "leave" instead
  if (target.role === "owner") return false;
  if (target.role === "admin") return actor === "owner";
  return isAdmin(actor);
}

/** Everyone but the owner may leave (the owner would orphan the org). */
export function canLeave(role: OrgRole): boolean {
  return role !== "owner";
}
