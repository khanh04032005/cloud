-- Vai D. Chạy được trước khi A xong schema phòng/đáp án.
-- Lambda nạp câu hỏi ghi vào hai bảng này trong một transaction.

CREATE TABLE IF NOT EXISTS question_sets (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  s3_bucket text NOT NULL,
  s3_key text NOT NULL,
  s3_etag text NOT NULL,
  sha256 text NOT NULL,
  question_count integer NOT NULL CHECK (question_count > 0),
  license text NOT NULL,
  document jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (s3_bucket, s3_key, s3_etag)
);

CREATE TABLE IF NOT EXISTS questions (
  id uuid PRIMARY KEY,
  set_id uuid NOT NULL REFERENCES question_sets (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  prompt text NOT NULL,
  answers jsonb NOT NULL,
  solution integer NOT NULL CHECK (solution >= 0),
  cooldown_seconds integer NOT NULL,
  time_seconds integer NOT NULL,
  max_points integer NOT NULL DEFAULT 1 CHECK (max_points >= 0),
  PRIMARY KEY (set_id, position),
  UNIQUE (id)
);

CREATE INDEX IF NOT EXISTS questions_set_idx ON questions (set_id, position);
