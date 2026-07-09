"""X-Ray Caries Sentinel (Agent 27, Hub 7)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

XRAY_ALLOWLIST = ["tooth_number", "caries_confidence_score"]

FIELD_PATTERNS = {
    "patient_name": re.compile(r"patient name:\s*([^\n]+)", re.IGNORECASE),
    "patient_id": re.compile(r"patient id:\s*([^\n]+)", re.IGNORECASE),
    "tooth_number": re.compile(r"tooth number:\s*([^\n]+)", re.IGNORECASE),
    "caries_confidence_score": re.compile(r"caries confidence score:\s*(\d*\.?\d+)", re.IGNORECASE),
}

HIGH_DECAY_THRESHOLD = 0.85


def hash_subject_id(patient_name, patient_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{patient_name}:{patient_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def extract_field(text, pattern):
    match = pattern.search(text)
    return match.group(1).strip() if match else ""


class XrayCariesSentinel:
    # Stage 1 (Bitewing Annotation Ingestion): patient name/ID are only
    # used to derive a hashed subject_id; only tooth number and the CV
    # classifier's confidence score survive into the record.
    def ingest(self, raw_text):
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise TypeError("raw_text must be a non-empty string")
        patient_name = extract_field(raw_text, FIELD_PATTERNS["patient_name"])
        patient_id = extract_field(raw_text, FIELD_PATTERNS["patient_id"])
        if not patient_name or not patient_id:
            raise ValueError("raw_text requires Patient Name and Patient ID to derive a subject_id")
        tooth_number = extract_field(raw_text, FIELD_PATTERNS["tooth_number"])
        if not tooth_number:
            raise ValueError("raw_text requires Tooth Number")

        record = {
            "subject_id": hash_subject_id(patient_name, patient_id),
            "tooth_number": tooth_number,
            "caries_confidence_score": float(extract_field(raw_text, FIELD_PATTERNS["caries_confidence_score"]) or 0),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in XRAY_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Decay Risk Screening): defense-in-depth guard,
    # then flag a high-confidence decay finding.
    def evaluate_decay_risk(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in XRAY_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached decay risk screening stage')

        high_decay = record["caries_confidence_score"] >= HIGH_DECAY_THRESHOLD
        return {"high_decay": high_decay, "status": "HIGH_DECAY_DETECTION" if high_decay else "ROUTINE_FINDING"}

    # Stage 3 (Integration): only reachable on a high-confidence finding —
    # an interactive, patient-facing case presentation to support informed
    # treatment consent.
    def build_patient_case_visualization(self, record, decay_result):
        return (
            f'CASE-PRESENTATION|{record["subject_id"]}|TOOTH:{record["tooth_number"]}|FINDING:{decay_result["status"]}|'
            f'CONFIDENCE:{record["caries_confidence_score"]}|VISUAL_AID:INTERACTIVE_3D_TOOTH_OVERLAY|'
            f'PATIENT_EXPLANATION:This X-ray shows a high-confidence area of decay on tooth {record["tooth_number"]} '
            f"that our AI imaging analysis flagged for review with your dentist.|GENERATED_AT:{iso_now()}"
        )

    # Stage 4 (Audit Telemetry): masked Splunk SIEM event on every reading.
    def build_splunk_event(self, record, decay_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "xray-caries-sentinel",
            "source": "hub7_dental_operations/xray_caries_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "status": decay_result["status"],
                "caries_confidence_score": record["caries_confidence_score"],
                "masked_tooth_number": mask_value(record["tooth_number"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_text):
        record = self.ingest(raw_text)
        decay_result = self.evaluate_decay_risk(record)
        case_presentation = self.build_patient_case_visualization(record, decay_result) if decay_result["high_decay"] else None
        splunk_event = self.build_splunk_event(record, decay_result, "high_decay_case_presented" if case_presentation else "routine_finding_logged")
        return {"case_presentation": case_presentation, "status": decay_result["status"], "splunk_event": splunk_event}
