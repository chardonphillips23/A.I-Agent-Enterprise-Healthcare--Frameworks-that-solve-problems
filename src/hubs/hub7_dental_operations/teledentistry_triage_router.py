"""Teledentistry Triage Router (Agent 29, Hub 7)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

MESSAGING_ALLOWLIST = ["detected_flags", "message_count"]

MAXILLOFACIAL_EMERGENCY_DICTIONARY = {
    "swelling": {"pattern": re.compile(r"swelling|swollen", re.IGNORECASE), "priority_tier": "critical", "label": "Facial/oral swelling"},
    "cannot_swallow": {"pattern": re.compile(r"cannot swallow|can't swallow|difficulty swallowing", re.IGNORECASE), "priority_tier": "critical", "label": "Difficulty swallowing (airway risk)"},
    "avulsed_tooth": {"pattern": re.compile(r"avulsed tooth|knocked out tooth|tooth knocked out", re.IGNORECASE), "priority_tier": "critical", "label": "Avulsed (knocked-out) tooth"},
    "broken_jaw": {"pattern": re.compile(r"broken jaw|jaw fracture|fractured jaw", re.IGNORECASE), "priority_tier": "critical", "label": "Suspected jaw fracture"},
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


class TeledentistryTriageRouter:
    # Stage 1 (Message Ingestion): the raw message text is only read here
    # to detect emergency flag matches; only the resulting flag keys and a
    # message-count metric survive — never the message text itself.
    def ingest(self, message_text, patient_identifiers, messaging_metadata=None):
        if not isinstance(message_text, str) or not message_text.strip():
            raise TypeError("message_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        messaging_metadata = messaging_metadata or {}

        detected_flags = [key for key, entry in MAXILLOFACIAL_EMERGENCY_DICTIONARY.items() if entry["pattern"].search(message_text)]

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "detected_flags": detected_flags,
            "message_count": int(messaging_metadata.get("message_count") or 1),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in MESSAGING_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Triage Rules): defense-in-depth guard, then map
    # detected flags to a priority tier.
    def classify_emergency_tier(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in MESSAGING_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached triage stage')

        matched_entries = [MAXILLOFACIAL_EMERGENCY_DICTIONARY[key] for key in record["detected_flags"]]
        priority_tier = "critical" if any(e["priority_tier"] == "critical" for e in matched_entries) else "routine"
        matched_labels = [e["label"] for e in matched_entries]

        return {"priority_tier": priority_tier, "matched_labels": matched_labels, "escalate": priority_tier != "routine"}

    # Stage 3 (Integration): whiteboard webhook update — runs on every
    # message, since the clinic whiteboard reflects every incoming case.
    def build_whiteboard_webhook_payload(self, record, triage_result):
        flags_display = ", ".join(triage_result["matched_labels"]) or "none"
        return (
            f'WEBHOOK-WHITEBOARD-UPDATE|{record["subject_id"]}|PRIORITY_TIER:{triage_result["priority_tier"]}|FLAGS:{flags_display}|'
            f"ROUTED_TO:EMERGENCY_WHITEBOARD|UPDATED_AT:{iso_now()}"
        )

    # Stage 4a (Oral Surgeon Sentinel Intercept): only built on a critical
    # priority tier.
    def build_oral_surgeon_page(self, record, triage_result):
        return {
            "channel": "oral_surgeon_stat_text",
            "priority": "stat",
            "subject_id": record["subject_id"],
            "headline": f'STAT: after-hours maxillofacial emergency — {"; ".join(triage_result["matched_labels"])}',
            "requested_action": "On-call oral surgeon must contact the patient immediately and advise on ED referral if airway compromise is suspected.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk record on every message.
    def build_splunk_event(self, record, triage_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "teledentistry-triage-router",
            "source": "hub7_dental_operations/teledentistry_triage_router",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "priority_tier": triage_result["priority_tier"],
                "masked_flags": [mask_value(label) for label in triage_result["matched_labels"]],
                "processed_at": iso_now(),
            },
        }

    def run(self, message_text, patient_identifiers, messaging_metadata):
        record = self.ingest(message_text, patient_identifiers, messaging_metadata)
        triage_result = self.classify_emergency_tier(record)
        webhook_payload = self.build_whiteboard_webhook_payload(record, triage_result)
        surgeon_page = self.build_oral_surgeon_page(record, triage_result) if triage_result["escalate"] else None
        splunk_event = self.build_splunk_event(record, triage_result, "stat_surgeon_paged" if surgeon_page else "routine_routed")
        return {"webhook_payload": webhook_payload, "surgeon_page": surgeon_page, "splunk_event": splunk_event, "priority_tier": triage_result["priority_tier"]}
