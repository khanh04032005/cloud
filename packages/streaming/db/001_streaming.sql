-- Role B owns these tables. Role A owns the outbox producer transaction.
CREATE TABLE IF NOT EXISTS score_processed_events (
  event_id uuid PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stats_processed_events (
  event_id uuid PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_scores (
  room_id text NOT NULL,
  player_id text NOT NULL,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE IF NOT EXISTS answer_rate_buckets (
  room_id text NOT NULL,
  bucket_start timestamptz NOT NULL,
  answer_count integer NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
  PRIMARY KEY (room_id, bucket_start)
);
