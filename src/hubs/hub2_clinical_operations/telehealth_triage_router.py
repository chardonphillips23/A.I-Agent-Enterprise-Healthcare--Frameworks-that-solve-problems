"""Telehealth Triage Router (Agent 7, Hub 2)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

MESSAGING_ALLOWLIST = ["detected_flags", "message_count", "session_duration_seconds"]

ACUTE_FLAG_DICTIONARY = {
    "chest_pain": {"pattern": re.compile(r"chest pain|chest tightness", re.IGNORECASE), "triage_level": "critical", "label": "Chest pain / cardiac concern"},
    "stroke": {"pattern": re.compile(r"stroke|face drooping|slurred speech|one[- ]sided weakness", re.IGNORECASE), "triage_level": "critical", "label": "Stroke symptoms"},
    "suicide": {"pattern": re.compile(r"suicide|kill myself|want to die|self[- ]harm", re.IGNORECASE), "triage_level": "critical", "label": "Suicidal ideation / self-harm risk"},
    "breathing": {"pattern": re.compile(r"can'?t breathe|shortness of breath|difficulty breathing", re.IGNORECASE), "triage_level": "urgent", "label": "Respiratory distress"},
}


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class TelehealthTriageRouter:
    # Stage 1 (Chat Ingestion): the raw chat text is only ever read here, to
    # detect which acute-flag categories it matches. Only the resulting flag
    # keys and session metrics — never the chat text itself — survive.
    def ingest(self, chat_text, patient_identifiers, messaging_metadata=None):
        if not isinstance(chat_text, str) or not chat_text.strip():
            raise TypeError("chat_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        messaging_metadata = messaging_metadata or {}

        detected_flags = [key for key, entry in ACUTE_FLAG_DICTIONARY.items() if entry["pattern"].search(chat_text)]

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "detected_flags": detected_flags,
            "message_count": int(messaging_metadata.get("message_count") or 1),
            "session_duration_seconds": int(messaging_metadata.get("session_duration_seconds") or 0),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in MESSAGING_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Triage Rules): defense-in-depth guard, then map
    # the detected flag keys to a triage level using the acute-flag dictionary.
    def classify_triage(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in MESSAGING_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached triage stage')

        matched_entries = [ACUTE_FLAG_DICTIONARY[key] for key in record["detected_flags"]]
        if any(e["triage_level"] == "critical" for e in matched_entries):
            triage_level = "critical"
        elif any(e["triage_level"] == "urgent" for e in matched_entries):
            triage_level = "urgent"
        else:
            triage_level = "routine"
        matched_labels = [e["label"] for e in matched_entries]

        return {"triage_level": triage_level, "matched_labels": matched_labels, "escalate": triage_level != "routine"}

    # Stage 3 (Integration): only built for escalated triage levels. Shapes
    # an instant digital routing link (WebRTC for critical, Twilio callback
    # for urgent) to connect the patient to a live clinician.
    def build_routing_payload(self, record, triage_result):
        now = datetime.now(timezone.utc)
        return {
            "channel": "emergency_webrtc_escalation" if triage_result["triage_level"] == "critical" else "urgent_twilio_callback",
            "subject_id": record["subject_id"],
            "triage_level": triage_result["triage_level"],
            "matched_flags": triage_result["matched_labels"],
            "routing_target": "ed_virtual_triage_room" if triage_result["triage_level"] == "critical" else "on_call_nurse_line",
            "webrtc_room_token": f'wrtc-{record["subject_id"][:12]}-{int(now.timestamp() * 1000)}',
            "twilio_callback_number": "+1-800-555-0100",
            "created_at": iso_now(),
        }

    # Stage 4 (Access Control Guard): reject the request outright if no
    # valid-looking OAuth2 bearer token is present.
    def validate_access_token(self, headers):
        auth_header = (headers or {}).get("authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise ValueError("Access denied: missing or malformed OAuth2 bearer token")
        token = auth_header[len("Bearer "):].strip()
        if len(token) < 20:
            raise ValueError("Access denied: OAuth2 token failed validation")
        return {"valid": True, "token_fingerprint": hashlib.sha256(token.encode()).hexdigest()[:12]}

    # Stage 4 (Audit Telemetry): masked Splunk SIEM log carrying a token
    # fingerprint rather than the raw bearer token.
    def build_splunk_event(self, record, triage_result, routing_payload, token_validation):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "telehealth-triage-router",
            "source": "hub2_clinical_operations/telehealth_triage_router",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": "escalation_routed" if routing_payload else "routine_no_escalation",
                "triage_level": triage_result["triage_level"],
                "masked_flags": [mask_value(label) for label in triage_result["matched_labels"]],
                "token_fingerprint": token_validation["token_fingerprint"],
                "processed_at": iso_now(),
            },
        }

    def run(self, chat_text, patient_identifiers, messaging_metadata, request_headers):
        record = self.ingest(chat_text, patient_identifiers, messaging_metadata)
        triage_result = self.classify_triage(record)
        routing_payload = self.build_routing_payload(record, triage_result) if triage_result["escalate"] else None
        token_validation = self.validate_access_token(request_headers)
        splunk_event = self.build_splunk_event(record, triage_result, routing_payload, token_validation)
        return {"triage_level": triage_result["triage_level"], "routing_payload": routing_payload, "splunk_event": splunk_event}
