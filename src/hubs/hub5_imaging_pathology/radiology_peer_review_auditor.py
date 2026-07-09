"""Radiology Peer Review Auditor (Agent 18, Hub 5)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

REVIEW_ALLOWLIST = ["human_impression_text", "ai_diagnostic_tag"]

CRITICAL_FINDING_KEYWORDS = ["pulmonary embolism", "aortic dissection", "tension pneumothorax", "acute hemorrhage"]

NEGATIVE_LANGUAGE_PATTERNS = [
    re.compile(r"no acute findings", re.IGNORECASE),
    re.compile(r"unremarkable", re.IGNORECASE),
    re.compile(r"negative for acute", re.IGNORECASE),
    re.compile(r"within normal limits", re.IGNORECASE),
]


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RadiologyPeerReviewAuditor:
    # Stage 1 (Report Ingestion): mrn/dob are only used to derive a hashed
    # subject_id; the human impression text and AI diagnostic tag are the
    # clinically necessary content Stage 2 compares against each other.
    def ingest(self, human_report_text, ai_tag_text, patient_identifiers):
        if not isinstance(human_report_text, str) or not human_report_text.strip():
            raise TypeError("human_report_text must be a non-empty string")
        if not isinstance(ai_tag_text, str) or not ai_tag_text.strip():
            raise TypeError("ai_tag_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "human_impression_text": human_report_text.strip(),
            "ai_diagnostic_tag": ai_tag_text.strip(),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in REVIEW_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Semantic Dissonance Check): defense-in-depth guard, then flag
    # a discrepancy if the AI tag names a critical finding while the human
    # report uses routine negative language.
    def evaluate_semantic_dissonance(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in REVIEW_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached dissonance check stage')

        ai_tag_lower = record["ai_diagnostic_tag"].lower()
        matched_critical_finding = next((kw for kw in CRITICAL_FINDING_KEYWORDS if kw in ai_tag_lower), None)
        human_is_negative = any(pattern.search(record["human_impression_text"]) for pattern in NEGATIVE_LANGUAGE_PATTERNS)
        discrepancy_detected = bool(matched_critical_finding) and human_is_negative

        return {"matched_critical_finding": matched_critical_finding, "human_is_negative": human_is_negative, "discrepancy_detected": discrepancy_detected}

    # Stage 3 (Integration): only reachable on a detected discrepancy.
    # Routes the case into the mandatory Senior QA peer review worklist.
    def build_peer_review_worklist_task(self, record, dissonance_result):
        return (
            f'QA-PEER-REVIEW-TASK|{record["subject_id"]}|PRIORITY:CRITICAL|AI_FINDING:{dissonance_result["matched_critical_finding"]}|'
            f"HUMAN_REPORT_STATUS:NEGATIVE_LANGUAGE_DETECTED|ROUTED_TO:SENIOR_QA_WORKLIST|CREATED_AT:{iso_now()}"
        )

    # Stage 4 (Audit Telemetry): tokenized Splunk record — the report text
    # never reaches the log, only a one-way content fingerprint and a
    # numeric variance index.
    def build_splunk_event(self, record, dissonance_result, outcome):
        content_fingerprint = hashlib.sha256(
            f'{record["human_impression_text"]}:{record["ai_diagnostic_tag"]}'.encode()
        ).hexdigest()[:16]

        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "radiology-peer-review-auditor",
            "source": "hub5_imaging_pathology/radiology_peer_review_auditor",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "discrepancy_detected": dissonance_result["discrepancy_detected"],
                "diagnostic_variance_index": 1 if dissonance_result["discrepancy_detected"] else 0,
                "content_fingerprint": content_fingerprint,
                "processed_at": iso_now(),
            },
        }

    def run(self, human_report_text, ai_tag_text, patient_identifiers):
        record = self.ingest(human_report_text, ai_tag_text, patient_identifiers)
        dissonance_result = self.evaluate_semantic_dissonance(record)
        peer_review_task = (
            self.build_peer_review_worklist_task(record, dissonance_result) if dissonance_result["discrepancy_detected"] else None
        )
        splunk_event = self.build_splunk_event(
            record, dissonance_result, "critical_discrepancy_escalated" if peer_review_task else "concordant_read"
        )
        return {"peer_review_task": peer_review_task, "discrepancy_detected": dissonance_result["discrepancy_detected"], "splunk_event": splunk_event}
