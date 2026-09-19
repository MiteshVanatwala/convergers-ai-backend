/**
 * Known admin permission keys (mirror of permissions seed in schema.sql).
 * Prefer these constants over string literals at call sites.
 */
export const AdminPermission = {
  ACCOUNT_VIEW: "account.view",
  ACCOUNT_REVEAL_CONTENT: "account.reveal_content",
  ACCOUNT_REFUND: "account.refund",
  ACCOUNT_SUSPEND: "account.suspend",
  TICKET_MANAGE: "ticket.manage",
  RISK_QUEUE_REVIEW: "risk_queue.review",
  DASHBOARD_VIEW_AGGREGATE: "dashboard.view_aggregate",
  PROVIDER_VIEW_HEALTH: "provider.view_health",
  PROVIDER_MANAGE_KEYS: "provider.manage_keys",
  PROVIDER_MANAGE_ROUTING: "provider.manage_routing",
  FEATURE_FLAGS_MANAGE: "feature_flags.manage",
  MODERATION_REVIEW: "moderation.review",
  ADMIN_USERS_MANAGE: "admin_users.manage",
} as const;

export type AdminPermissionKey = (typeof AdminPermission)[keyof typeof AdminPermission];
