-- Sprint 4 WO1 — SCHEMA-003: org_members table + seed from existing org owners

CREATE TABLE IF NOT EXISTS org_members (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_members_org    ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user   ON org_members(user_id);

-- Migrate existing org owners into org_members
INSERT INTO org_members (id, org_id, user_id, role, created_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  owner_id,
  'owner',
  created_at
FROM organisations
WHERE NOT EXISTS (
  SELECT 1 FROM org_members m
  WHERE m.org_id = organisations.id AND m.user_id = organisations.owner_id
);
