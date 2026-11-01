"""Common public event format for independent school projects."""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

KST = timezone(timedelta(hours=9))


def stamp(value):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError("event timestamps require a timezone")
    return dt


def signup_url(value):
    if not value:
        return ""
    parts = urlsplit(value)
    host = (parts.hostname or "").lower()
    if (parts.scheme != "https" or not host or "." not in host or parts.username or parts.password
            or parts.port not in (None, 443) or any(c.isspace() for c in value)
            or host.endswith((".local", ".localhost", ".internal", ".invalid", ".test"))):
        raise ValueError("public HTTPS signup URL required")
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None
    if addr and not addr.is_global:
        raise ValueError("local signup URL")
    return value


def normalize(feed, source, at=None):
    """Reject invalid input; allowlist public fields even for third-party adapters."""
    at = at or datetime.now(KST)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", source):
        raise ValueError("invalid source")
    if feed.get("schemaVersion") != 1 or feed.get("source") != source:
        raise ValueError("event feed source/schema mismatch")
    raw = feed.get("events")
    if not isinstance(raw, list) or len(raw) > 100:
        raise ValueError("events must be a list of at most 100 records")
    lease = stamp(feed["validUntil"]) if feed.get("validUntil") else None
    events, ids = [], set()
    for event in raw:
        if not isinstance(event, dict):
            raise ValueError("invalid event")
        row = {}
        for key, limit in (("id", 100), ("title", 100), ("summary", 800), ("grades", 80),
                           ("start", 10), ("end", 10), ("until", 40), ("signupUrl", 2000)):
            value = event.get(key, "")
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError("invalid event field: " + key)
            row[key] = value
        if not row["id"] or not row["title"] or row["id"] in ids:
            raise ValueError("missing/duplicate event identity")
        ids.add(row["id"])
        end = stamp(row["until"])
        if lease:
            end = min(end, lease)
        row["until"] = end.isoformat()
        row["signupUrl"] = signup_url(row["signupUrl"])
        for key in ("start", "end"):
            if row[key]:
                from datetime import date
                date.fromisoformat(row[key])
        if end > at:
            events.append(row)
    return {"schemaVersion": 1, "source": source, "events": events}


def load_events(directory, at=None):
    events = []
    for path in sorted(Path(directory).glob("*.json")):
        feed = normalize(json.loads(path.read_text(encoding="utf-8")), path.stem, at)
        for event in feed["events"]:
            events.append({**event, "id": feed["source"] + ":" + event["id"], "source": feed["source"]})
    return events
