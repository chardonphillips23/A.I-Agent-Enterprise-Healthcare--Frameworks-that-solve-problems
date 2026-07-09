"""CDT Claim Scrubber (Agent 26, Hub 7)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

CLAIM_ALLOWLIST = ["primary_cdt_code", "secondary_cdt_code", "quadrant"]

CONFLICTING_CODE_PAIR = {"primary": "D4341", "secondary": "D1110"}


def hash_subject_id(patient_name, patient_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{patient_name}:{patient_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CdtClaimScrubber:
    # Stage 1 (Billing Code Ingestion): patient identity strings are only
    # used to derive a hashed subject_id; only the CDT codes and quadrant
    # survive into the record.
    def ingest(self, raw_claim):
        raw_claim = raw_claim or {}
        patient_name = raw_claim.get("patient_name")
        patient_id = raw_claim.get("patient_id")
        primary_cdt_code = raw_claim.get("primary_cdt_code")
        secondary_cdt_code = raw_claim.get("secondary_cdt_code")
        quadrant = raw_claim.get("quadrant")
        if not patient_name or not patient_id:
            raise ValueError("raw_claim requires patient_name and patient_id to derive a subject_id")
        if not primary_cdt_code or not secondary_cdt_code or not quadrant:
            raise ValueError("raw_claim requires primary_cdt_code, secondary_cdt_code, and quadrant")

        record = {
            "subject_id": hash_subject_id(patient_name, patient_id),
            "primary_cdt_code": primary_cdt_code,
            "secondary_cdt_code": secondary_cdt_code,
            "quadrant": quadrant,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in CLAIM_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (CDT Compliance Rules): defense-in-depth guard, then flag a
    # code conflict when deep scaling (D4341) and standard prophylaxis
    # (D1110) are billed together on the same quadrant.
    def evaluate_cdt_compliance(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in CLAIM_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached compliance evaluation stage')

        conflict = record["primary_cdt_code"] == CONFLICTING_CODE_PAIR["primary"] and record["secondary_cdt_code"] == CONFLICTING_CODE_PAIR["secondary"]
        return {"conflict": conflict, "status": "CDT_CODE_CONFLICT" if conflict else "CLEARED"}

    # Stage 3 (Integration): only reachable when Stage 2 clears the claim.
    def build_claim_scrubbing_payload(self, record):
        return (
            f'CDT-CLAIM-SCRUB|{record["subject_id"]}|QUADRANT:{record["quadrant"]}|PRIMARY:{record["primary_cdt_code"]}|'
            f'SECONDARY:{record["secondary_cdt_code"]}|STATUS:VALIDATED|SCRUBBED_AT:{iso_now()}'
        )

    # Stage 4a (Billing Desk Intercept): only reachable on a code conflict —
    # the scrubbed claim payload is never generated on this path.
    def build_billing_correction_ticket(self, record):
        return {
            "channel": "billing_desk_correction_queue",
            "priority": "hard_block",
            "subject_id": record["subject_id"],
            "headline": f'CDT code conflict: {CONFLICTING_CODE_PAIR["primary"]} (deep scaling) billed alongside {CONFLICTING_CODE_PAIR["secondary"]} (prophylaxis) on quadrant {record["quadrant"]}',
            "detail": "These two procedure codes cannot be billed together for the same quadrant on the same date of service per payer coding edits.",
            "requested_action": "Remove one of the conflicting codes or bill on separate dates of service before resubmitting.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk event on every claim.
    def build_splunk_event(self, record, compliance_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "cdt-claim-scrubber",
            "source": "hub7_dental_operations/cdt_claim_scrubber",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "status": compliance_result["status"],
                "quadrant": record["quadrant"],
                "masked_primary_cdt_code": mask_value(record["primary_cdt_code"]),
                "masked_secondary_cdt_code": mask_value(record["secondary_cdt_code"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_claim):
        record = self.ingest(raw_claim)
        compliance_result = self.evaluate_cdt_compliance(record)

        if not compliance_result["conflict"]:
            claim_payload = self.build_claim_scrubbing_payload(record)
            splunk_event = self.build_splunk_event(record, compliance_result, "validated_and_transmitted")
            return {"claim_payload": claim_payload, "correction_ticket": None, "splunk_event": splunk_event}

        correction_ticket = self.build_billing_correction_ticket(record)
        splunk_event = self.build_splunk_event(record, compliance_result, "blocked_code_conflict")
        return {"claim_payload": None, "correction_ticket": correction_ticket, "splunk_event": splunk_event}
