BEGIN;

-- Score storage and its processing marker already belong to migration 001.
-- Stats has a separate marker because it consumes the same events independently.
CREATE TABLE stats_processed_events (
    event_id uuid PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE answer_rate_buckets (
    room_id uuid NOT NULL REFERENCES rooms (id),
    bucket_start timestamptz NOT NULL,
    answer_count integer NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
    PRIMARY KEY (room_id, bucket_start)
);

COMMIT;
