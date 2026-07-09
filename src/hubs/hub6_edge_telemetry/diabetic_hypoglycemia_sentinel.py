"""Diabetic Hypoglycemia Sentinel (Agent 22, Hub 6)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

CGM_ALLOWLIST = ["current_glucose", "drop_velocity", "caregiver_phone"]

FIELD_PATTERNS = {
    "caregiver_phone": re.compile(r"caregiver phone:\s*([^\n]+)", re.IGNORECASE),
    "current_glucose": re.compile(r"current glucose:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE),
    "drop_velocity": re.compile(r"drop velocity:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE),
}

HYPOGLYCEMIA_GLUCOSE_THRESHOLD = 60
HYPOGLYCEMIA_VELOCITY_THRESHOLD = 3


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


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


class DiabeticHypoglycemiaSentinel:
    # Stage 1 (CGM Ingestion): mrn/dob are only used to derive a hashed
    # subject_id; glucose reading, drop velocity, and the caregiver contact
    # needed for Stage 3 dispatch survive into the record.
    def ingest(self, raw_text, patient_identifiers):
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise TypeError("raw_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        current_glucose_match = FIELD_PATTERNS["current_glucose"].search(raw_text)
        if not current_glucose_match:
            raise ValueError("raw_text requires a Current Glucose reading")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "current_glucose": float(current_glucose_match.group(1)),
            "drop_velocity": float(extract_field(raw_text, FIELD_PATTERNS["drop_velocity"]) or 0),
            "caregiver_phone": extract_field(raw_text, FIELD_PATTERNS["caregiver_phone"]) or None,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in CGM_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Crash Risk Rules): defense-in-depth guard, then
    # flag a severe crash risk on a low absolute reading or a steep drop.
    def evaluate_glucose_crash(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in CGM_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached crash evaluation stage')

        critical_risk = record["current_glucose"] < HYPOGLYCEMIA_GLUCOSE_THRESHOLD or record["drop_velocity"] > HYPOGLYCEMIA_VELOCITY_THRESHOLD
        return {"critical_risk": critical_risk, "status": "HYPOGLYCEMIC_CRASH_RISK" if critical_risk else "STABLE"}

    # Stage 3 (Integration): only reachable on a critical crash risk.
    def build_caregiver_sms_alert(self, record):
        destination = record["caregiver_phone"] or "UNKNOWN_CAREGIVER"
        return (
            f'TWILIO-SMS|TO:{destination}|PRIORITY:URGENT|MESSAGE:Glucose alert - reading {record["current_glucose"]} mg/dL, '
            f'drop velocity {record["drop_velocity"]} mg/dL per minute. Please check on your family member immediately and '
            f"administer fast-acting glucose if trained to do so.|SENT_AT:{iso_now()}"
        )

    # Stage 4 (Access Control Guard): reject the request outright if no
    # valid-looking security signature is present.
    def validate_security_signature(self, headers):
        auth_header = (headers or {}).get("authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise ValueError("Access denied: missing or malformed security signature")
        token = auth_header[len("Bearer "):].strip()
        if len(token) < 20:
            raise ValueError("Access denied: security signature failed validation")
        return {"valid": True, "token_fingerprint": hashlib.sha256(token.encode()).hexdigest()[:12]}

    # Stage 4 (Audit Telemetry): masked Splunk SIEM log — glucose reading
    # and caregiver contact are masked before they reach the log.
    def build_splunk_event(self, record, crash_result, outcome, token_validation):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "diabetic-hypoglycemia-sentinel",
            "source": "hub6_edge_telemetry/diabetic_hypoglycemia_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": crash_result["critical_risk"],
                "status": crash_result["status"],
                "masked_glucose": mask_value(record["current_glucose"]),
                "masked_caregiver_phone": mask_value(record["caregiver_phone"]),
                "token_fingerprint": token_validation["token_fingerprint"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_text, patient_identifiers, request_headers):
        record = self.ingest(raw_text, patient_identifiers)
        crash_result = self.evaluate_glucose_crash(record)
        sms_alert = self.build_caregiver_sms_alert(record) if crash_result["critical_risk"] else None
        token_validation = self.validate_security_signature(request_headers)
        splunk_event = self.build_splunk_event(record, crash_result, "hypoglycemic_crash_alerted" if sms_alert else "stable_reading", token_validation)
        return {"sms_alert": sms_alert, "status": crash_result["status"], "splunk_event": splunk_event}
