"""Public event safety and remote publication retry behavior (no network)."""
import base64
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import event_feed
import sync_integrations as bridge


def feed():
    return {"schemaVersion": 1, "source": "example", "events": [{"id": "1", "title": "학교 행사",
        "summary": "안내", "until": "2099-11-01T23:59:59+09:00", "signupUrl": "https://forms.gle/example",
        "students": [{"email": "private"}]}]}


class EventFeedTests(unittest.TestCase):
    def test_allowlist_identity_and_lease(self):
        raw = feed()
        raw["validUntil"] = "2026-11-02T00:00:00+09:00"
        normalized = event_feed.normalize(raw, "example", datetime.fromisoformat("2026-11-01T00:00:00+09:00"))
        self.assertNotIn("students", normalized["events"][0])
        self.assertEqual(normalized["events"][0]["until"], raw["validUntil"])
        self.assertEqual(event_feed.normalize(raw, "example", datetime.fromisoformat(raw["validUntil"]))["events"], [])
        with self.assertRaises(ValueError):
            event_feed.normalize(raw, "different")

    def test_rejects_private_and_script_signup_links(self):
        for url in ("javascript:alert(1)", "https://192.168.0.1", "https://127.0.0.1", "https://school.local"):
            raw = feed()
            raw["events"][0]["signupUrl"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                event_feed.normalize(raw, "example")

    def test_changed_update_uses_fresh_sha_on_conflict(self):
        calls = []
        def api(endpoint, method="GET", payload=None):
            calls.append((method, payload))
            if method == "GET":
                return {"sha": str(len(calls)), "content": base64.b64encode(b"{}").decode()}
            if len(calls) == 2:
                raise RuntimeError("conflict")
        with patch.object(bridge, "gh_api", side_effect=api), patch.object(bridge.time, "sleep"):
            self.assertTrue(bridge.upload("owner/repo", "example", feed()))
        self.assertNotEqual(calls[1][1]["sha"], calls[3][1]["sha"])

    def test_failed_upload_retries_and_unchanged_feed_uses_no_network(self):
        config = {"repository": "owner/repo", "sources": [{"id": "example"}]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge, "read_source", return_value=feed()):
            state = Path(tmp) / "state.json"
            with patch.object(bridge, "upload", side_effect=RuntimeError("offline")):
                self.assertEqual(bridge.sync(config, state, True), 1)
                self.assertFalse(state.exists())
            with patch.object(bridge, "upload") as upload:
                self.assertEqual(bridge.sync(config, state, True), 0)
                self.assertEqual(bridge.sync(config, state, True), 0)
                self.assertEqual(upload.call_count, 1)
