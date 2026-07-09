"""DICOM Stroke Triage (Agent 16, Hub 5)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

DICOM_ALLOWLIST = ["modality", "body_part_examined", "scan_protocol", "hemorrhage_confidence_score"]

FIELD_PATTERNS = {
    "patient_name": re.compile(r"patient name:\s*([^\n]+)", re.IGNORECASE),
    "patient_id": re.compile(r"patient id:\s*([^\n]+)", re.IGNORECASE),
    "modality": re.compile(r"modality:\s*([^\n]+)", re.IGNORECASE),
    "body_part_examined": re.compile(r"body part examined:\s*([^\n]+)", re.IGNORECASE),
    "scan_protocol": re.compile(r"scan protocol:\s*([^\n]+)", re.IGNORECASE),
    "hemorrhage_score": re.compile(r"hemorrhage confidence score:\s*(\d*\.?\d+)", re.IGNORECASE),
}

HEMORRHAGE_ALERT_THRESHOLD = 0.85


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


class DicomStrokeTriage:
    # Stage 1 (DICOM Header Ingestion): PatientName/PatientID tags are only
    # used to derive a hashed subject_id; only imaging metadata and the
    # simulated hemorrhage classifier score survive into the record.
    def ingest(self, raw_header_text):
        if not isinstance(raw_header_text, str) or not raw_header_text.strip():
            raise TypeError("raw_header_text must be a non-empty string")
        patient_name = extract_field(raw_header_text, FIELD_PATTERNS["patient_name"])
        patient_id = extract_field(raw_header_text, FIELD_PATTERNS["patient_id"])
        if not patient_name or not patient_id:
            raise ValueError("raw_header_text requires Patient Name and Patient ID to derive a subject_id")

        score_field = extract_field(raw_header_text, FIELD_PATTERNS["hemorrhage_score"])
        record = {
            "subject_id": hash_subject_id(patient_name, patient_id),
            "modality": extract_field(raw_header_text, FIELD_PATTERNS["modality"]) or "unknown",
            "body_part_examined": extract_field(raw_header_text, FIELD_PATTERNS["body_part_examined"]) or "unknown",
            "scan_protocol": extract_field(raw_header_text, FIELD_PATTERNS["scan_protocol"]) or "unknown",
            "hemorrhage_confidence_score": float(score_field) if score_field else 0,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in DICOM_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Stroke Risk Screening): defense-in-depth guard,
    # then flag a critical stroke alert only on CT modality at or above the
    # hemorrhage confidence threshold.
    def evaluate_stroke_risk(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in DICOM_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached screening stage')

        is_ct = "CT" in record["modality"].upper()
        critical_risk = is_ct and record["hemorrhage_confidence_score"] >= HEMORRHAGE_ALERT_THRESHOLD

        return {"is_ct": is_ct, "critical_risk": critical_risk}

    # Stage 3 (Integration): HL7 v2 MDM^T02 document notification — runs on
    # every read, since the notification documents the study regardless of
    # outcome.
    def build_mdm_stroke_notification(self, record, risk_result):
        now = datetime.now(timezone.utc)
        hl7_timestamp = now.strftime("%Y%m%dT%H%M%S")
        message_id = f"MSG{int(now.timestamp() * 1000)}"
        observation_status = "A" if risk_result["critical_risk"] else "F"

        segments = [
            f"MSH|^~\\&|DICOM_STROKE_TRIAGE|RADIOLOGY|CLINICAL_ALERTING|HOSPITAL|{hl7_timestamp}||MDM^T02|{message_id}|P|2.5",
            f'PID|1||{record["subject_id"]}',
            f'TXA|1|RA^Radiology Report|TEXT|||||||{record["subject_id"]}||||AV',
            f'OBX|1|ST|MODALITY^Modality||{record["modality"]}||||||F',
            f'OBX|2|ST|BODYPART^Body Part Examined||{record["body_part_examined"]}||||||F',
            f'OBX|3|NM|ICH_SCORE^Hemorrhage Confidence Score||{record["hemorrhage_confidence_score"]}||||||{observation_status}',
        ]

        return "\r".join(segments)

    # Stage 4a (Neurology Sentinel Intercept): only built when the critical
    # hemorrhage threshold is met on a CT study.
    def build_neurology_pager_dispatch(self, record):
        return {
            "channel": "stat_neurology_pager",
            "priority": "stat",
            "subject_id": record["subject_id"],
            "headline": f'STAT: acute intracranial hemorrhage suspected — confidence {record["hemorrhage_confidence_score"]}',
            "detail": f'{record["modality"]} {record["body_part_examined"]} (protocol: {record["scan_protocol"]}) flagged by AI hemorrhage classifier at {record["hemorrhage_confidence_score"] * 100:.1f}% confidence.',
            "requested_action": "STAT neurology consult required; activate stroke protocol immediately.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk event on every read.
    def build_splunk_event(self, record, risk_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "dicom-stroke-triage",
            "source": "hub5_imaging_pathology/dicom_stroke_triage",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": risk_result["critical_risk"],
                "hemorrhage_confidence_score": record["hemorrhage_confidence_score"],
                "modality": record["modality"],
                "masked_body_part": mask_value(record["body_part_examined"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_header_text):
        record = self.ingest(raw_header_text)
        risk_result = self.evaluate_stroke_risk(record)
        mdm_message = self.build_mdm_stroke_notification(record, risk_result)
        pager_dispatch = self.build_neurology_pager_dispatch(record) if risk_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, risk_result, "stat_neurology_paged" if pager_dispatch else "routine_read")
        return {"mdm_message": mdm_message, "pager_dispatch": pager_dispatch, "splunk_event": splunk_event, "critical_risk": risk_result["critical_risk"]}
