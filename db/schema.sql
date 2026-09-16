-- Convergers AI — Postgres schema
--
-- Companion to the platform specification (Frontend, Admin & Database).
-- Tables are ordered so this file runs top to bottom with no forward
-- references. Partitioned tables (messages, credit_ledger, usage_events)
-- get one starting partition each — add the next month's before it starts,
-- ideally via a scheduled job rather than by hand.
--
-- This is the schema only: no seed data, no roles/grants. Before this runs
-- against a real environment, revoke UPDATE/DELETE on credit_ledger and
-- admin_audit_log for the application role — both are append-only by
-- policy, and the policy only means something if the database enforces it.
--
-- CREATE DATABASE cannot run inside a transaction. Connect to the default
-- `postgres` database first, then reconnect after this statement.

CREATE DATABASE convergers_ai;
\c convergers_ai

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive email columns


-- =========================================================================
-- 00. Plans, accounts & auth
-- =========================================================================

CREATE TABLE plans (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key               text NOT NULL UNIQUE, -- 'pay_as_you_go' | 'growth' | 'scale' — stable, never renamed
  display_name      text NOT NULL,        -- editable by marketing without touching the key
  price_usd_cents   integer,
  included_credits  integer,
  rate_limit_rpm    integer,
  features          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  email_verified_at  timestamptz,
  auth_provider      text NOT NULL,       -- 'google' | 'password'
  google_id          text UNIQUE,
  password_hash      text,
  name               text,
  avatar_url         text,
  status             text NOT NULL DEFAULT 'active', -- active | suspended | soft_deleted
  risk_score         smallint NOT NULL DEFAULT 0,
  last_login_at      timestamptz,         -- denormalized from login_events for a cheap "last seen" read
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_status ON accounts (status);

CREATE TABLE login_events (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ip_address          inet,
  device_fingerprint  text,
  user_agent          text,
  is_new_device       boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_events_account ON login_events (account_id, created_at DESC);

CREATE TABLE risk_signals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type                text NOT NULL,      -- 'signup' | 'velocity_limit'
  ip_address          inet,
  device_fingerprint  text,
  risk_score          smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_risk_signals_account ON risk_signals (account_id, created_at DESC);


-- =========================================================================
-- 01. Organizations & teams
-- =========================================================================

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  owner_id    uuid NOT NULL REFERENCES accounts(id),
  plan_id     bigint REFERENCES plans(id),
  pool_mode   text NOT NULL DEFAULT 'shared', -- shared | per_seat
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_organizations_owner ON organizations (owner_id);

CREATE TABLE organization_members (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member', -- owner | admin | member | billing
  seat_budget   integer,
  invited_at    timestamptz NOT NULL DEFAULT now(),
  joined_at     timestamptz,
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX idx_org_members_account ON organization_members (account_id);


-- =========================================================================
-- 02. Billing: payment methods, subscriptions, purchases, ledger
-- =========================================================================

CREATE TABLE payment_methods (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  org_id                    uuid REFERENCES organizations(id),
  stripe_payment_method_id  text NOT NULL UNIQUE,
  brand                     text,          -- visa | mastercard | amex | ...
  last4                     text,
  exp_month                 smallint,
  exp_year                  smallint,
  is_default                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  removed_at                timestamptz
);
-- Never stores a raw card number — Stripe Elements tokenizes it client-side
-- before it reaches the backend; this table only holds Stripe's safe
-- display metadata plus its own reference id. Removing a card sets
-- removed_at instead of deleting the row, so a past invoice or
-- credit_ledger entry still resolves to what was actually charged.
CREATE INDEX idx_payment_methods_account ON payment_methods (account_id);
CREATE UNIQUE INDEX idx_payment_methods_one_default
  ON payment_methods (account_id)
  WHERE is_default AND removed_at IS NULL;

CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid REFERENCES accounts(id),
  org_id                    uuid REFERENCES organizations(id),
  plan_id                   bigint NOT NULL REFERENCES plans(id),
  stripe_subscription_id    text UNIQUE,
  status                    text NOT NULL DEFAULT 'active', -- active | past_due | canceled
  current_period_end        timestamptz,
  auto_recharge_enabled     boolean NOT NULL DEFAULT false,
  auto_recharge_threshold   numeric(12,2),
  auto_recharge_topup       numeric(12,2),
  default_payment_method_id uuid REFERENCES payment_methods(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_one_owner CHECK (
    (account_id IS NOT NULL AND org_id IS NULL) OR (account_id IS NULL AND org_id IS NOT NULL)
  )
);
CREATE INDEX idx_subscriptions_account ON subscriptions (account_id);
CREATE INDEX idx_subscriptions_org ON subscriptions (org_id);

CREATE TABLE credit_purchases (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES accounts(id),
  stripe_payment_intent_id  text NOT NULL UNIQUE,
  credits                   numeric(14,2) NOT NULL,
  amount_usd_cents          integer NOT NULL,
  status                    text NOT NULL DEFAULT 'pending', -- pending | succeeded | failed
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_purchases_account ON credit_purchases (account_id, created_at DESC);

CREATE TABLE credit_wallets (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance       numeric(14,2) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  amount           numeric(14,2) NOT NULL, -- negative = debit, positive = credit
  reason           text NOT NULL,          -- debit | refund | purchase | reversal | promo
  balance_after    numeric(14,2) NOT NULL,
  reference_type   text,                   -- 'usage_event' | 'stripe_payment' | 'admin_grant'
  reference_id     text,
  created_by       uuid,                   -- admin_users.id, when reason requires a human (refund, promo)
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_ledger_account ON credit_ledger (account_id, created_at DESC);
-- Append-only by policy: revoke UPDATE/DELETE for the application role,
-- corrections happen via a new 'reversal' row, never an edit.

CREATE TABLE credit_ledger_2026_09 PARTITION OF credit_ledger
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE credit_ledger_2026_10 PARTITION OF credit_ledger
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');


-- =========================================================================
-- 03. Projects, conversations & messages
-- =========================================================================

CREATE TABLE projects (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  org_id       uuid REFERENCES organizations(id),
  name         text NOT NULL,
  color        text,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_account ON projects (account_id);

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id       bigint REFERENCES projects(id) ON DELETE SET NULL,
  title            text,
  title_status     text NOT NULL DEFAULT 'pending'
                     CHECK (title_status IN ('pending', 'generated', 'manual')),
  pinned           boolean NOT NULL DEFAULT false,
  archived         boolean NOT NULL DEFAULT false,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Powers the recent-chats sidebar: one index serves the sort AND the filter.
CREATE INDEX idx_conversations_account_recent
  ON conversations (account_id, pinned DESC, last_message_at DESC)
  WHERE archived = false;
CREATE INDEX idx_conversations_project ON conversations (project_id);
CREATE INDEX idx_conversations_account_recents
  ON conversations (account_id, last_message_at DESC, id DESC)
  WHERE archived = false AND pinned = false AND project_id IS NULL;

CREATE TABLE messages (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES accounts(id), -- denormalized from conversations: RLS on this table needs a direct equality check, not a per-row join
  role               text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content            text NOT NULL,
  content_search     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  provider           text,
  task_type          text,
  tokens_input       integer,
  tokens_output      integer,
  credits_charged    numeric(12,2),
  status             text NOT NULL DEFAULT 'complete'
                       CHECK (status IN ('complete', 'error', 'cancelled')),
  client_message_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_account ON messages (account_id, created_at DESC);
CREATE INDEX idx_messages_search ON messages USING GIN (content_search);
CREATE INDEX idx_messages_client_message
  ON messages (account_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE messages_2026_09 PARTITION OF messages
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE messages_2026_10 PARTITION OF messages
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE messages_2026_11 PARTITION OF messages
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE messages_2026_12 PARTITION OF messages
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE messages_2027_01 PARTITION OF messages
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE messages_2027_02 PARTITION OF messages
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE messages_2027_03 PARTITION OF messages
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

CREATE TABLE labels (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text
);

CREATE TABLE conversation_labels (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id         bigint NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE message_feedback (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id     bigint NOT NULL,
  account_id     uuid NOT NULL REFERENCES accounts(id),
  signal         text NOT NULL,           -- thumbs_up | thumbs_down | override
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- First-party quality/override signal for training the in-house classifier
-- — deliberately never provider *output* distillation, which the product
-- plan rules out on ToS grounds.
CREATE INDEX idx_feedback_message ON message_feedback (message_id);

CREATE TABLE orchestration_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  plan             jsonb NOT NULL,        -- ordered steps, e.g. [{step: 'write_post'}, {step: 'generate_cover_image'}]
  completed_steps  integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'in_progress', -- in_progress | done | failed
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Checkpoints a multi-step chain after each step, so a mid-chain failure
-- resumes instead of restarting — and re-billing — from step one.


-- =========================================================================
-- 04. LLM & provider management
-- =========================================================================

CREATE TABLE provider_registry (
  id                text PRIMARY KEY,     -- e.g. 'anthropic:claude'
  label             text NOT NULL,
  capabilities      jsonb NOT NULL DEFAULT '[]',
  cost_per_unit     numeric(12,6),
  unit_type         text,                 -- 'token' | 'image' | 'second'
  context_window    integer,
  rpm_limit         integer,
  tpm_limit         integer,
  status            text NOT NULL DEFAULT 'active', -- active | degraded | deprecated
  tos_flags         jsonb NOT NULL DEFAULT '{}',
  data_terms        jsonb NOT NULL DEFAULT '{}',
  last_verified_at  timestamptz
);
-- Deliberately NOT storing live error_rate/p95_latency columns here: the
-- router reads this row on every single request, and health metrics change
-- every few seconds — that combination is a lock-contention trap. Live
-- health lives in Redis; provider_health_snapshots gets a periodic rollup.

CREATE TABLE provider_health_snapshots (
  provider_id     text NOT NULL REFERENCES provider_registry(id),
  error_rate      numeric(5,4),
  p95_latency_ms  integer,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, captured_at)
);

CREATE TABLE provider_api_keys (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id    text NOT NULL REFERENCES provider_registry(id),
  encrypted_key  bytea NOT NULL,          -- KMS-encrypted, never selected back raw over the API
  source         text NOT NULL DEFAULT 'override', -- override | env
  is_active      boolean NOT NULL DEFAULT true,
  last_used_at   timestamptz,
  rotated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid                     -- admin_users.id
);
CREATE INDEX idx_provider_api_keys_provider ON provider_api_keys (provider_id);

CREATE TABLE provider_routing_rules (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_type     text NOT NULL,
  provider_id   text NOT NULL REFERENCES provider_registry(id),
  rank          smallint NOT NULL,        -- 1 = first choice, 2 = first fallback, ...
  enabled       boolean NOT NULL DEFAULT true,
  UNIQUE (task_type, provider_id)
);


-- =========================================================================
-- 05. Usage & analytics (operational — behavioral analytics lives in
--     PostHog, not here; see the platform spec's scaling notes)
-- =========================================================================

CREATE TABLE usage_events (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  conversation_id  uuid,
  message_id       bigint,
  task_type        text NOT NULL,
  provider         text NOT NULL,
  outcome          text NOT NULL,         -- success | error
  tokens_input     integer,
  tokens_output    integer,
  native_cost      numeric(12,6),
  credits_charged  numeric(12,2),
  fallback_used    boolean NOT NULL DEFAULT false,
  override_used    boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- This is the exact shape usageLog.ts already produces, plus override_used
-- — the POC's summary()/recent() logic becomes a query against this table.
CREATE INDEX idx_usage_account_time ON usage_events (account_id, created_at DESC);
CREATE INDEX idx_usage_provider_time ON usage_events (provider, created_at DESC);

CREATE TABLE usage_events_2026_09 PARTITION OF usage_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE usage_events_2026_10 PARTITION OF usage_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE usage_events_2026_11 PARTITION OF usage_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE usage_events_2026_12 PARTITION OF usage_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE usage_events_2027_01 PARTITION OF usage_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE usage_events_2027_02 PARTITION OF usage_events
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE usage_events_2027_03 PARTITION OF usage_events
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

CREATE TABLE feature_flags (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                   text NOT NULL UNIQUE,
  description           text,
  rollout_percentage    smallint NOT NULL DEFAULT 0,
  enabled               boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_queue (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id     bigint NOT NULL,
  flag_reason    text NOT NULL,
  status         text NOT NULL DEFAULT 'pending', -- pending | cleared | actioned
  reviewed_by    uuid,                    -- admin_users.id
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);


-- =========================================================================
-- 06. Admin: internal users, audit log, support
-- =========================================================================

CREATE TABLE admin_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  username        citext UNIQUE,           -- password login id (admin panel); null until admin_auth.sql / seed
  password_hash   text,                    -- scrypt / bcrypt hash — never plain
  role            text NOT NULL,          -- support | ops_business | engineering_admin
  status          text NOT NULL DEFAULT 'active', -- active | deactivated
  invited_by      uuid REFERENCES admin_users(id),
  password_changed_at timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
-- Deactivation sets status + deactivated_at rather than deleting the row —
-- admin_audit_log rows reference admin_user_id and must never lose that
-- reference, the same append-only reasoning as credit_ledger's reversals.

-- Permissions are a real, queryable table, not prose in a spec: admin-api
-- checks a specific capability, not a hardcoded `role === 'support'` string
-- scattered across the codebase. Roles are just a named bundle of these.
CREATE TABLE permissions (
  key          text PRIMARY KEY,          -- e.g. 'account.refund', 'provider.manage_keys'
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role            text NOT NULL,
  permission_key  text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role, permission_key)
);

INSERT INTO permissions (key, description) VALUES
  ('account.view',            'View a customer account, plan, and credit balance'),
  ('account.reveal_content',  'Reveal a redacted prompt/response for a specific ticket (always audit-logged)'),
  ('account.refund',          'Issue a manual credit grant or refund, with a reason'),
  ('account.suspend',         'Suspend or reinstate a customer account'),
  ('ticket.manage',           'View and respond to support tickets'),
  ('risk_queue.review',       'Approve or ban a flagged signup or velocity-limit review'),
  ('dashboard.view_aggregate','View business/ops dashboards — no individual account data'),
  ('provider.view_health',    'View provider health and rate-limit gauges'),
  ('provider.manage_keys',    'Add, rotate, or remove a provider API key'),
  ('provider.manage_routing', 'Edit the routing/fallback sequence per task type'),
  ('feature_flags.manage',    'Edit feature-flag rollout percentages'),
  ('moderation.review',       'Review the content-moderation queue'),
  ('admin_users.manage',      'Invite, promote, or deactivate other admin users — gates who manages the managers');

INSERT INTO role_permissions (role, permission_key) VALUES
  ('support',           'account.view'),
  ('support',           'account.reveal_content'),
  ('support',           'account.refund'),
  ('support',           'ticket.manage'),
  ('ops_business',      'dashboard.view_aggregate'),
  ('ops_business',      'provider.view_health'),
  ('ops_business',      'risk_queue.review'),
  ('engineering_admin', 'account.view'),
  ('engineering_admin', 'account.reveal_content'),
  ('engineering_admin', 'account.refund'),
  ('engineering_admin', 'account.suspend'),
  ('engineering_admin', 'ticket.manage'),
  ('engineering_admin', 'risk_queue.review'),
  ('engineering_admin', 'dashboard.view_aggregate'),
  ('engineering_admin', 'provider.view_health'),
  ('engineering_admin', 'provider.manage_keys'),
  ('engineering_admin', 'provider.manage_routing'),
  ('engineering_admin', 'feature_flags.manage'),
  ('engineering_admin', 'moderation.review'),
  ('engineering_admin', 'admin_users.manage');
-- Only engineering_admin gets admin_users.manage by default — a support or
-- ops_business admin cannot invite, promote, or deactivate any admin
-- account, including their own.

CREATE TABLE admin_audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id  uuid NOT NULL REFERENCES admin_users(id),
  action         text NOT NULL,           -- e.g. 'reveal_message_content', 'grant_credits'
  target_type    text NOT NULL,           -- 'account' | 'conversation' | 'provider_api_key'
  target_id      text NOT NULL,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Append-only by policy, same as credit_ledger — this table is the whole
-- point of "access is logged, not just gated"; it cannot be editable and
-- still mean anything.
CREATE INDEX idx_admin_audit_admin ON admin_audit_log (admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit_log (target_type, target_id);

ALTER TABLE provider_api_keys ADD CONSTRAINT fk_provider_api_keys_admin
  FOREIGN KEY (created_by) REFERENCES admin_users(id);
ALTER TABLE credit_ledger ADD CONSTRAINT fk_credit_ledger_admin
  FOREIGN KEY (created_by) REFERENCES admin_users(id);
ALTER TABLE moderation_queue ADD CONSTRAINT fk_moderation_reviewer
  FOREIGN KEY (reviewed_by) REFERENCES admin_users(id);

CREATE TABLE support_tickets (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts(id),
  admin_user_id  uuid REFERENCES admin_users(id),
  subject        text NOT NULL,
  status         text NOT NULL DEFAULT 'open', -- open | pending | closed
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_tickets_account ON support_tickets (account_id, created_at DESC);


-- =========================================================================
-- 07. Product & developer surface
-- =========================================================================

CREATE TABLE api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  key_hash       text NOT NULL UNIQUE,    -- never store the raw key, only its hash
  scopes         jsonb NOT NULL DEFAULT '[]',
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_org ON api_keys (org_id);

CREATE TABLE notification_preferences (
  account_id              uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email_product_updates   boolean NOT NULL DEFAULT true,
  email_usage_alerts      boolean NOT NULL DEFAULT true,
  email_security          boolean NOT NULL DEFAULT true,
  push_enabled            boolean NOT NULL DEFAULT false
);

CREATE TABLE personalization_settings (
  account_id                uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  theme                     text NOT NULL DEFAULT 'system', -- light | dark | system
  language                  text NOT NULL DEFAULT 'en',
  custom_instructions       text,
  default_provider_override text
);

CREATE TABLE data_requests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts(id),
  type           text NOT NULL,           -- export | delete
  status         text NOT NULL DEFAULT 'pending', -- pending | processing | completed
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX idx_data_requests_account ON data_requests (account_id);
CREATE INDEX idx_data_requests_pending ON data_requests (status) WHERE status <> 'completed';
