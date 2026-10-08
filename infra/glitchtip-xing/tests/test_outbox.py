import json
import tempfile
import unittest
from pathlib import Path
from support import CONFIG, SECRET, SECRET2, URL, PRIVATE, payload
from xing_alerts.privacy import normalize
from xing_alerts.outbox import Store, CapacityError, subscription_id


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "state.sqlite3"
        self.store = Store(
            self.path, "dummy-django-secret", max_pending=2, max_subscriptions=2
        )
        self.sid = subscription_id(
            "12", "talk.operational_alert", {"projectId": 3}, URL
        )
        self.subscribe()

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def subscribe(self, secret=SECRET, expires=2000):
        self.store.subscribe(self.sid, "12", URL, secret, "test-bearer", expires, 1000)

    def test_credentials_encrypted_restart_retry_identity(self):
        self.store.enqueue(normalize(payload(), CONFIG, 1000), 1000)
        item = self.store.next_due(1000)
        eid = item["event"]["eventId"]
        self.store.finish(item, 500, 1000)
        self.store.close()
        for file in Path(self.tmp.name).glob("*"):
            data = file.read_bytes()
            for secret in [
                SECRET.encode(),
                URL.encode(),
                b"test-bearer",
                PRIVATE.encode(),
            ]:
                self.assertNotIn(secret, data)
        self.store = Store(self.path, "dummy-django-secret", max_pending=2)
        self.assertIsNone(self.store.next_due(1001))
        retry = self.store.next_due(1060)
        self.assertEqual(retry["event"]["eventId"], eid)
        self.assertEqual(retry["attempts"], 1)

    def test_dedup_window_allows_reopened_recurrence_and_capacity(self):
        alert = normalize(payload(), CONFIG, 1000)
        self.assertEqual(self.store.enqueue(alert, 1000), 1)
        self.assertEqual(self.store.enqueue(alert, 1001), 0)
        self.assertEqual(self.store.enqueue(alert, 1061), 1)
        with self.assertRaises(CapacityError):
            self.store.enqueue(normalize(payload(43), CONFIG, 1062), 1062)

    def test_unsubscribe_expiry_and_status_privacy(self):
        self.store.enqueue(normalize(payload(), CONFIG, 1000), 1000)
        self.store.deactivate(self.sid, "12")
        self.assertIsNone(self.store.next_due(1000))
        self.subscribe(expires=1001)
        self.store.enqueue(normalize(payload(43), CONFIG, 1000), 1000)
        self.assertIsNone(self.store.next_due(1002))
        status = json.dumps(self.store.status("12", 1002))
        for value in [URL, SECRET, "test-bearer", PRIVATE]:
            self.assertNotIn(value, status)

    def test_rotation_bounded_retention_and_410(self):
        self.subscribe(SECRET2)
        sub = self.store.get_subscription(self.sid)
        self.assertEqual(sub["old_secret"], SECRET)
        self.assertEqual(sub["old_until"], 1120)
        self.store.enqueue(normalize(payload(), CONFIG, 1000), 1000)
        item = self.store.next_due(1000)
        self.store.finish(item, 410, 1000)
        self.assertFalse(self.store.get_subscription(self.sid)["active"])
        self.store.prune(1000 + 8 * 86400)
        self.assertEqual(self.store.status("12", 1000 + 8 * 86400)["pending"], 0)

    def test_id_canonical_owner_isolation(self):
        self.assertEqual(
            subscription_id("12", "n", {"a": 1, "b": 2}, URL),
            subscription_id("12", "n", {"b": 2, "a": 1}, URL),
        )
        self.assertNotEqual(
            self.sid,
            subscription_id("13", "talk.operational_alert", {"projectId": 3}, URL),
        )

    def test_crash_attempt_is_persistent_and_bounded(self):
        self.subscribe(expires=4600)
        self.store.enqueue(normalize(payload(), CONFIG, 1000), 1000)
        at = 1000
        for number in range(6):
            item = self.store.next_due(at)
            self.assertEqual(item["attempts"], number)
            self.assertTrue(self.store.begin_attempt(item, at))
            self.store.close()
            self.store = Store(self.path, "dummy-django-secret")
            self.assertIsNone(self.store.next_due(at + 1))
            at += min(600, 30 * 2**number) + 1
        self.assertIsNone(self.store.next_due(at))
        self.assertEqual(self.store.status("12", at)["failed"], 1)

    def test_batch_capacity_failure_rolls_back_all_work(self):
        alerts = (
            normalize(payload(), CONFIG, 1000)
            + normalize(payload(43), CONFIG, 1000)
            + normalize(payload(44), CONFIG, 1000)
        )
        with self.assertRaises(CapacityError):
            self.store.enqueue(alerts, 1000)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0
        )
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM dedup").fetchone()[0], 0
        )
