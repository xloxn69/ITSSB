"""SQLite schema for route drafts (migration 3), kept apart from drafts.py so
database.py can import it without a cycle."""

DRAFTS_MIGRATION = """
CREATE TABLE route_drafts (
    draft_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_school','from_school')),
    status TEXT NOT NULL CHECK (status IN ('recording','finished')),
    driver_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER
);
CREATE TABLE route_draft_points (
    draft_id TEXT NOT NULL REFERENCES route_drafts(draft_id),
    seq INTEGER NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    horizontal_accuracy_m REAL,
    gap_before INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (draft_id, seq)
);
CREATE TABLE route_draft_stops (
    stop_id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES route_drafts(draft_id),
    request_id TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    marked_by_driver_id TEXT NOT NULL
);
CREATE INDEX route_draft_stops_order ON route_draft_stops(draft_id, position);
"""

# Migration 6: a finished draft's submissions for staff review (docs/08 §7.1).
# One row per Submit press. `payload` is the exact wire body, saved before
# anything is sent and resent unchanged; it holds the driver grant, so it is
# never returned to the screen. `sync` is the upload: pending until the
# server answers, then accepted or rejected. `review_*` is the staff review
# state the server last reported, with the device time it was read.
SUBMISSIONS_MIGRATION = """
CREATE TABLE route_draft_submissions (
    request_id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES route_drafts(draft_id),
    payload TEXT NOT NULL,
    sync TEXT NOT NULL DEFAULT 'pending' CHECK (sync IN ('pending','accepted','rejected')),
    code TEXT,
    message TEXT,
    server_draft_id TEXT,
    review_status TEXT CHECK (review_status IN ('submitted','approved','rejected','not_found')),
    review_reason TEXT,
    reviewed_at_ms INTEGER,
    review_checked_at_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    captured_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER
);
CREATE INDEX route_draft_submissions_draft ON route_draft_submissions(draft_id, captured_at_ms);
CREATE INDEX route_draft_submissions_pending ON route_draft_submissions(sync, captured_at_ms);
"""

# Migration 7: the order review-status reads rotate through awaiting drafts.
# An increasing counter, set to max+1 on every draft a read asks about, so the
# rotation never depends on the wall clock (which can step backward).
REVIEW_ROTATION_MIGRATION = """
ALTER TABLE route_draft_submissions ADD COLUMN review_check_seq INTEGER NOT NULL DEFAULT 0;
"""
