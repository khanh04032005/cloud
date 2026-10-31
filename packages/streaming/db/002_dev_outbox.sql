-- Local fixture and contract example only. Role A owns this migration in the app.
CREATE TABLE IF NOT EXISTS outbox (
  event_id uuid PRIMARY KEY,
  room_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox (created_at, event_id) WHERE published_at IS NULL;
