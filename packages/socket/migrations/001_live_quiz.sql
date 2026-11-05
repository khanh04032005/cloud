BEGIN;

CREATE TABLE quizzes (
    id text PRIMARY KEY,
    subject text NOT NULL
);

CREATE TABLE questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quiz_id text NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position > 0),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    UNIQUE (quiz_id, position)
);

CREATE TABLE rooms (
    id uuid PRIMARY KEY,
    invite_code text NOT NULL CHECK (invite_code ~ '^[0-9]{6}$'),
    host_client_id uuid NOT NULL,
    quiz_id text REFERENCES quizzes (id) ON DELETE SET NULL,
    subject text NOT NULL,
    status text NOT NULL DEFAULT 'lobby'
        CHECK (status IN ('lobby', 'running', 'finished', 'cancelled')),
    settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CHECK ((status = 'finished') = (finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX rooms_active_invite_code_idx ON rooms (invite_code)
    WHERE status IN ('lobby', 'running');

CREATE TABLE players (
    room_id uuid NOT NULL REFERENCES rooms (id),
    id uuid NOT NULL,
    username text NOT NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, id)
);

CREATE TABLE rounds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms (id),
    question_id uuid REFERENCES questions (id) ON DELETE SET NULL,
    position integer NOT NULL CHECK (position > 0),
    question_snapshot jsonb NOT NULL CHECK (jsonb_typeof(question_snapshot) = 'object'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed')),
    closes_at timestamptz,
    UNIQUE (room_id, id),
    UNIQUE (room_id, position)
);

CREATE UNIQUE INDEX rounds_one_open_per_room_idx ON rounds (room_id)
    WHERE status = 'open';

CREATE TABLE answers (
    room_id uuid NOT NULL,
    round_id uuid NOT NULL,
    player_id uuid NOT NULL,
    choice integer NOT NULL CHECK (choice >= 0),
    is_correct boolean NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (round_id, player_id),
    FOREIGN KEY (room_id, round_id) REFERENCES rounds (room_id, id),
    FOREIGN KEY (room_id, player_id) REFERENCES players (room_id, id)
);

CREATE TABLE outbox (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id uuid NOT NULL,
    player_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    UNIQUE (round_id, player_id),
    FOREIGN KEY (round_id, player_id) REFERENCES answers (round_id, player_id)
);

CREATE INDEX outbox_pending_idx ON outbox (created_at, event_id)
    WHERE published_at IS NULL;

CREATE TABLE results (
    room_id uuid NOT NULL,
    player_id uuid NOT NULL,
    points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
    PRIMARY KEY (room_id, player_id),
    FOREIGN KEY (room_id, player_id) REFERENCES players (room_id, id)
);

CREATE TABLE processed_answer_events (
    event_id uuid PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
