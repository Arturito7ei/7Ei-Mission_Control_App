-- Sprint 4 WO1 — SCHEMA-002: Agent profile fields (persona, expertise, advisorIds)

ALTER TABLE agents ADD COLUMN persona TEXT;
ALTER TABLE agents ADD COLUMN expertise TEXT;
ALTER TABLE agents ADD COLUMN advisor_ids TEXT;
