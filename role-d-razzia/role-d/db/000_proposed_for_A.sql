-- ĐỀ XUẤT cho vai A. Không apply nếu A đã có migration riêng.
-- Tên cột khớp event answer_accepted mà vai B đã chốt trên nhánh
-- feature/role-b-streaming (packages/streaming/src/contract.mjs).
--
-- Vai D chỉ phụ thuộc các bảng này ở Lambda xuất CSV và câu SQL đối chiếu điểm.
-- Bảng outbox, player_scores, score_processed_events thuộc vai B, không tạo lại ở đây.

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  question_set_id uuid,
  status text NOT NULL CHECK (status IN ('lobby', 'running', 'finished')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS players (
  id text NOT NULL,
  room_id text NOT NULL REFERENCES rooms (id),
  display_name text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms (id),
  question_id uuid,
  position integer NOT NULL CHECK (position >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'open', 'closed')),
  closes_at timestamptz,
  UNIQUE (room_id, position)
);

-- Đáp án đầu tiên thắng. event_id là khóa idempotent mà worker của B cũng dùng.
CREATE TABLE IF NOT EXISTS answers (
  round_id text NOT NULL REFERENCES rounds (id),
  player_id text NOT NULL,
  choice jsonb NOT NULL,
  is_correct boolean NOT NULL,
  accepted_at timestamptz NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (round_id, player_id)
);

CREATE INDEX IF NOT EXISTS answers_player_idx ON answers (player_id);
