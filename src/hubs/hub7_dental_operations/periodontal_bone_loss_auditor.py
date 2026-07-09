"""Periodontal Bone Loss Auditor (Agent 28, Hub 7)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

CHART_ALLOWLIST = ["requested_procedure", "measurements"]

MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM = 5


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class PeriodontalBoneLossAuditor:
    # Stage 1 (Charting Ingestion): mrn/dob are only used to derive a
    # hashed subject_id; only the requested procedure and per-tooth pocket
    # depth measurements survive into the record.
    def ingest(self, raw_chart, patient_identifiers):
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        raw_chart = raw_chart or {}
        requested_procedure = raw_chart.get("requested_procedure")
        measurements = raw_chart.get("measurements")
        if not requested_procedure:
            raise ValueError("raw_chart requires requested_procedure")
        if not isinstance(measurements, list) or len(measurements) == 0:
            raise ValueError("raw_chart requires a non-empty measurements list")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "requested_procedure": requested_procedure,
            "measurements": [
                {"tooth_number": m.get("tooth_number"), "pocket_depth_millimeters": float(m.get("pocket_depth_millimeters"))}
                for m in measurements
            ],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in CHART_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Pre-Authorization Compliance Rules): defense-in-depth guard,
    # then flag an exception if osseous surgery is requested without at
    # least one measured pocket depth of 5mm or more.
    def evaluate_pre_auth(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in CHART_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached pre-auth evaluation stage')

        max_pocket_depth = max(m["pocket_depth_millimeters"] for m in record["measurements"])
        requests_osseous_surgery = "osseous" in record["requested_procedure"].lower()
        exception = requests_osseous_surgery and max_pocket_depth < MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM

        return {"max_pocket_depth": max_pocket_depth, "exception": exception, "status": "INSUFFICIENT_BONE_LOSS_EVIDENCE" if exception else "CLEARED"}

    # Stage 3 (Integration): only reachable on a pre-auth exception. A
    # soft-block — the hygienist can still supply the missing evidence.
    def build_soft_block_request(self, record, pre_auth_result):
        return (
            f'PERIO-PREAUTH-SOFT-BLOCK|{record["subject_id"]}|PROCEDURE:{record["requested_procedure"]}|'
            f'MAX_POCKET_DEPTH_MM:{pre_auth_result["max_pocket_depth"]}|REQUIRED_MIN_MM:{MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM}|'
            f"ACTION_REQUIRED:APPEND_DIGITAL_RADIOGRAPHIC_MEASUREMENTS|REQUESTED_BY:HYGIENIST|CREATED_AT:{iso_now()}"
        )

    # Stage 4 (Audit Telemetry): tokenized Splunk record carrying a
    # pre-authorization variance fingerprint rather than the full chart.
    def build_splunk_event(self, record, pre_auth_result, outcome):
        variance_fingerprint = hashlib.sha256(
            f'{record["requested_procedure"]}:{pre_auth_result["max_pocket_depth"]}'.encode()
        ).hexdigest()[:12]

        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "periodontal-bone-loss-auditor",
            "source": "hub7_dental_operations/periodontal_bone_loss_auditor",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "exception": pre_auth_result["exception"],
                "status": pre_auth_result["status"],
                "max_pocket_depth": pre_auth_result["max_pocket_depth"],
                "variance_fingerprint": variance_fingerprint,
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_chart, patient_identifiers):
        record = self.ingest(raw_chart, patient_identifiers)
        pre_auth_result = self.evaluate_pre_auth(record)
        soft_block_request = self.build_soft_block_request(record, pre_auth_result) if pre_auth_result["exception"] else None
        splunk_event = self.build_splunk_event(record, pre_auth_result, "preauth_soft_blocked" if soft_block_request else "preauth_cleared")
        return {"soft_block_request": soft_block_request, "status": pre_auth_result["status"], "splunk_event": splunk_event}
