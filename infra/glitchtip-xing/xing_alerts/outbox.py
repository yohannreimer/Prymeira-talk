"""Single-process, bounded durable queue. Credentials are purpose-encrypted."""

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import uuid
from pathlib import Path
from cryptography.fernet import Fernet
from .config import EVENT_NAME


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    )


def subscription_id(owner, name, args, url):
    return (
        "sub_"
        + hashlib.sha256(canonical([owner, name, args, url]).encode()).hexdigest()
    )


class CapacityError(RuntimeError):
    def __init__(self):
        super().__init__("bridge_capacity")


class Store:
    def __init__(
        self,
        path,
        django_secret,
        *,
        max_pending=1000,
        max_subscriptions=100,
        retention=7 * 86400,
        dedup_seconds=60,
        max_events=2000,
        max_attempts=6,
    ):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = hmac.new(
            django_secret.encode(), b"glitchtip-xing-subscriptions:v1", hashlib.sha256
        ).digest()
        self.cipher = Fernet(base64.urlsafe_b64encode(key))
        self.max_pending = max_pending
        self.max_subscriptions = max_subscriptions
        self.retention = retention
        self.dedup_seconds = dedup_seconds
        self.max_events = max_events
        self.max_attempts = max_attempts
        self.db = sqlite3.connect(path, timeout=0.25)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA foreign_keys=ON;
          PRAGMA journal_mode=DELETE;
          PRAGMA synchronous=FULL;
          PRAGMA secure_delete=ON;
          PRAGMA max_page_count=8192;
          CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,owner TEXT NOT NULL,credentials BLOB NOT NULL,
            expires REAL NOT NULL,active INTEGER NOT NULL,updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,body TEXT NOT NULL,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS deliveries (
            event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
            state TEXT NOT NULL,attempts INTEGER NOT NULL,due REAL NOT NULL,
            PRIMARY KEY(event_id,subscription_id));
          CREATE INDEX IF NOT EXISTS due_index ON deliveries(state,due);
          CREATE TABLE IF NOT EXISTS dedup (identity TEXT PRIMARY KEY,expires REAL NOT NULL);
        """)

    def close(self):
        self.db.close()

    def _encrypt(self, value):
        return self.cipher.encrypt(canonical(value).encode())

    def get_subscription(self, sid):
        row = self.db.execute(
            "SELECT * FROM subscriptions WHERE id=?", (sid,)
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        result.update(json.loads(self.cipher.decrypt(result.pop("credentials"))))
        return result

    def subscribe(self, sid, owner, url, secret, bearer, expires, now):
        if not now < expires <= now + 3600:
            raise ValueError("invalid_expiry")
        old = self.get_subscription(sid)
        if old and old["owner"] != owner:
            raise ValueError("invalid_owner")
        credentials = {
            "url": url,
            "secret": secret,
            "bearer": bearer,
            "old_secret": None,
            "old_until": 0,
        }
        if old and old["active"] and old["expires"] > now:
            if old["secret"] != secret:
                credentials.update(old_secret=old["secret"], old_until=now + 120)
            elif old["old_until"] > now:
                credentials.update(
                    old_secret=old["old_secret"], old_until=old["old_until"]
                )
        with self.db:
            if (
                not old
                and self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
                >= self.max_subscriptions
            ):
                raise CapacityError()
            self.db.execute(
                """INSERT INTO subscriptions VALUES (?,?,?,?,1,?)
                ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials,
                expires=excluded.expires,active=1,updated=excluded.updated""",
                (sid, owner, self._encrypt(credentials), expires, now),
            )

    def deactivate(self, sid, owner):
        with self.db:
            self.db.execute(
                "UPDATE subscriptions SET active=0 WHERE id=? AND owner=?", (sid, owner)
            )
            self.db.execute(
                """UPDATE deliveries SET state='cancelled' WHERE subscription_id=?
                AND state='pending' AND EXISTS (SELECT 1 FROM subscriptions WHERE id=? AND owner=?)""",
                (sid, sid, owner),
            )

    def _prune(self, now):
        self.db.execute("UPDATE subscriptions SET active=0 WHERE expires<=?", (now,))
        self.db.execute("""UPDATE deliveries SET state='cancelled' WHERE state='pending'
          AND subscription_id IN (SELECT id FROM subscriptions WHERE active=0)""")
        self.db.execute("DELETE FROM events WHERE created<?", (now - self.retention,))
        self.db.execute(
            "DELETE FROM subscriptions WHERE active=0 AND updated<?",
            (now - self.retention,),
        )
        self.db.execute("DELETE FROM dedup WHERE expires<=?", (now,))

    def _reserve_events(self, slots):
        # Delete only enough oldest completed history for the entire new batch.
        # This runs inside enqueue's transaction; a later failure restores history.
        count = self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        if count + slots > self.max_events:
            self.db.execute(
                """DELETE FROM events WHERE id IN (SELECT id FROM events
                WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE event_id=events.id AND state='pending')
                ORDER BY created,id LIMIT ?)""",
                (count + slots - self.max_events,),
            )

    def prune(self, now):
        with self.db:
            self._prune(now)

    def enqueue(self, alerts, now):
        # Normalize the entire webhook first, then one atomic transaction for fanout.
        with self.db:
            self._prune(now)
            subscribers = self.db.execute(
                "SELECT id FROM subscriptions WHERE active=1 AND expires>?", (now,)
            ).fetchall()
            new = []
            seen = set()
            for alert in alerts:
                identity = hashlib.sha256(
                    canonical(
                        {k: v for k, v in alert.items() if k != "timestamp"}
                    ).encode()
                ).hexdigest()
                if (
                    identity in seen
                    or self.db.execute(
                        "SELECT 1 FROM dedup WHERE identity=?", (identity,)
                    ).fetchone()
                ):
                    continue
                seen.add(identity)
                new.append((identity, alert))
            self._reserve_events(len(new))
            pending = self.db.execute(
                "SELECT COUNT(*) FROM deliveries WHERE state='pending'"
            ).fetchone()[0]
            events = self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            dedups = self.db.execute("SELECT COUNT(*) FROM dedup").fetchone()[0]
            if (
                pending + len(new) * len(subscribers) > self.max_pending
                or events + len(new) > self.max_events
                or dedups + len(new) > 1000
            ):
                raise CapacityError()
            for identity, alert in new:
                eid = "evt_" + uuid.uuid4().hex
                event = {
                    "eventId": eid,
                    "name": EVENT_NAME,
                    "timestamp": alert["timestamp"],
                    "data": {k: v for k, v in alert.items() if k != "timestamp"},
                    "cursor": None,
                }
                self.db.execute(
                    "INSERT INTO events VALUES (?,?,?)", (eid, canonical(event), now)
                )
                self.db.execute(
                    "INSERT INTO dedup VALUES (?,?)",
                    (identity, now + self.dedup_seconds),
                )
                for sub in subscribers:
                    self.db.execute(
                        "INSERT INTO deliveries VALUES (?,?,'pending',0,?)",
                        (eid, sub["id"], now),
                    )
            return len(new)

    def next_due(self, now):
        self.prune(now)
        with self.db:
            self.db.execute(
                "UPDATE deliveries SET state='failed' WHERE state='pending' AND attempts>=? AND due<=?",
                (self.max_attempts, now),
            )
        row = self.db.execute(
            """SELECT d.*,e.body FROM deliveries d JOIN events e ON e.id=d.event_id
            JOIN subscriptions s ON s.id=d.subscription_id WHERE d.state='pending' AND d.due<=?
            AND s.active=1 AND s.expires>? ORDER BY d.due,e.created LIMIT 1""",
            (now, now),
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        result["event"] = json.loads(result.pop("body"))
        return result

    def begin_attempt(self, item, now):
        """Commit attempt/backoff before network; crash retries still have a bound."""
        attempt = item["attempts"] + 1
        with self.db:
            changed = self.db.execute(
                """UPDATE deliveries SET attempts=?,due=?
                WHERE event_id=? AND subscription_id=? AND state='pending' AND attempts=?""",
                (
                    attempt,
                    now + min(600, 30 * 2 ** (attempt - 1)),
                    item["event_id"],
                    item["subscription_id"],
                    item["attempts"],
                ),
            ).rowcount
        if changed:
            item["attempt_started"] = True
        return bool(changed)

    def finish(self, item, status, now):
        attempt = item["attempts"] + 1
        if 200 <= status < 300:
            state = "accepted"
        elif status in (410, 413) or attempt >= self.max_attempts:
            state = "failed"
        else:
            state = "pending"
        with self.db:
            if status == 410:
                row = self.db.execute(
                    "SELECT owner FROM subscriptions WHERE id=?",
                    (item["subscription_id"],),
                ).fetchone()
                if row:
                    self.deactivate(item["subscription_id"], row["owner"])
            self.db.execute(
                """UPDATE deliveries SET state=?,attempts=?,due=?
                WHERE event_id=? AND subscription_id=? AND state='pending' """,
                (
                    state,
                    attempt,
                    now + min(600, 30 * 2 ** (attempt - 1)),
                    item["event_id"],
                    item["subscription_id"],
                ),
            )

    def status(self, owner, now):
        self.prune(now)
        counts = {"pending": 0, "accepted": 0, "failed": 0, "cancelled": 0}
        rows = self.db.execute(
            """SELECT d.state,COUNT(*) n FROM deliveries d
            JOIN subscriptions s ON s.id=d.subscription_id WHERE s.owner=? GROUP BY d.state""",
            (owner,),
        ).fetchall()
        for row in rows:
            counts[row["state"]] = row["n"]
        counts["activeSubscriptions"] = self.db.execute(
            "SELECT COUNT(*) FROM subscriptions WHERE owner=? AND active=1 AND expires>?",
            (owner, now),
        ).fetchone()[0]
        return counts
