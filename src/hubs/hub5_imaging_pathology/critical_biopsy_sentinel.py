"""Critical Biopsy Sentinel (Agent 17, Hub 5)."""

import hashlib
import json
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

BIOPSY_ALLOWLIST = ["accession_number", "specimen_source", "findings"]

FIELD_PATTERNS = {
    "mrn": re.compile(r"mrn:\s*([^\n]+)", re.IGNORECASE),
    "dob": re.compile(r"dob:\s*([^\n]+)", re.IGNORECASE),
    "accession_number": re.compile(r"accession number:\s*([^\n]+)", re.IGNORECASE),
    "specimen_source": re.compile(r"specimen source:\s*([^\n]+)", re.IGNORECASE),
    "findings": re.compile(r"findings:\s*([^\n]+)", re.IGNORECASE),
}

MALIGNANCY_RISK_KEYS = [
    {"pattern": re.compile(r"malignant melanoma", re.IGNORECASE), "label": "Malignant melanoma"},
    {"pattern": re.compile(r"high-grade glioblastoma|glioblastoma multiforme", re.IGNORECASE), "label": "High-grade glioblastoma"},
    {"pattern": re.compile(r"acute myeloid leukemia", re.IGNORECASE), "label": "Acute myeloid leukemia"},
    {"pattern": re.compile(r"small cell lung carcinoma", re.IGNORECASE), "label": "Small cell lung carcinoma"},
]


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


class CriticalBiopsySentinel:
    # Stage 1 (Pathology Ingestion): mrn/dob are only used to derive a
    # hashed subject_id; accession number, specimen source, and the findings
    # text needed for Stage 2's keyword screen survive into the record.
    def ingest(self, raw_text):
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise TypeError("raw_text must be a non-empty string")
        mrn = extract_field(raw_text, FIELD_PATTERNS["mrn"])
        dob = extract_field(raw_text, FIELD_PATTERNS["dob"])
        if not mrn or not dob:
            raise ValueError("raw_text requires MRN and DOB to derive a subject_id")
        accession_number = extract_field(raw_text, FIELD_PATTERNS["accession_number"])
        specimen_source = extract_field(raw_text, FIELD_PATTERNS["specimen_source"])
        if not accession_number or not specimen_source:
            raise ValueError("raw_text requires Accession Number and Specimen Source")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "accession_number": accession_number,
            "specimen_source": specimen_source,
            "findings": extract_field(raw_text, FIELD_PATTERNS["findings"]) or "",
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in BIOPSY_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Malignancy Keyword Screening): defense-in-depth guard, then
    # regex-match the findings text against hyper-aggressive malignancy keys.
    def screen_malignancy(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in BIOPSY_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached screening stage')

        matched = [entry["label"] for entry in MALIGNANCY_RISK_KEYS if entry["pattern"].search(record["findings"])]
        high_priority = len(matched) > 0

        return {"matched": matched, "high_priority": high_priority, "triage_level": "critical_escalation" if high_priority else "routine"}

    # Stage 3 (Integration): only reachable on a high-priority match. Shapes
    # an expedited FHIR ServiceRequest targeted at oncology scheduling,
    # serialized as a payload string.
    def build_oncology_service_request(self, record, screen_result):
        service_request = {
            "resourceType": "ServiceRequest",
            "status": "active",
            "intent": "order",
            "priority": "stat",
            "subject": {"reference": f'Patient/{record["subject_id"]}'},
            "category": [{"text": "oncology-consult"}],
            "code": {"text": "Expedited oncology consultation"},
            "reasonCode": [{"text": "; ".join(screen_result["matched"])}],
            "occurrenceDateTime": iso_now(),
            "note": [{"text": f'Accession {record["accession_number"]}, specimen source: {record["specimen_source"]}'}],
        }
        return json.dumps(service_request)

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

    # Stage 4 (Audit Telemetry): masked Splunk SIEM event — specimen details
    # are masked before they reach the log.
    def build_splunk_event(self, record, screen_result, outcome, token_validation):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "critical-biopsy-sentinel",
            "source": "hub5_imaging_pathology/critical_biopsy_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "triage_level": screen_result["triage_level"],
                "masked_accession_number": mask_value(record["accession_number"]),
                "masked_specimen_source": mask_value(record["specimen_source"]),
                "token_fingerprint": token_validation["token_fingerprint"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_text, request_headers):
        record = self.ingest(raw_text)
        screen_result = self.screen_malignancy(record)
        service_request_payload = self.build_oncology_service_request(record, screen_result) if screen_result["high_priority"] else None
        token_validation = self.validate_security_signature(request_headers)
        splunk_event = self.build_splunk_event(
            record, screen_result, "critical_oncology_escalation" if service_request_payload else "routine_pathology_review", token_validation
        )
        return {"service_request_payload": service_request_payload, "triage_level": screen_result["triage_level"], "splunk_event": splunk_event}
