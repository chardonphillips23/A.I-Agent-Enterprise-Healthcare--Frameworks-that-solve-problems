"""Smart Pillbox Adherence Auditor (Agent 25, Hub 6)."""

import hashlib
import math
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

PILLBOX_ALLOWLIST = ["compartment_label", "open_event_timestamps"]

NON_ADHERENCE_WINDOW_HOURS = 48


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


class SmartPillboxAdherenceAuditor:
    # Stage 1 (Pillbox Event Ingestion): mrn/dob are only used to derive a
    # hashed subject_id; the compartment label and lid-opening timestamps
    # survive into the record.
    def ingest(self, raw_pillbox_data, patient_identifiers):
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        raw_pillbox_data = raw_pillbox_data or {}
        compartment_label = raw_pillbox_data.get("compartment_label")
        open_event_timestamps = raw_pillbox_data.get("open_event_timestamps")
        if not compartment_label:
            raise ValueError("raw_pillbox_data requires compartment_label")
        if not isinstance(open_event_timestamps, list):
            raise ValueError("raw_pillbox_data requires open_event_timestamps to be a list")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "compartment_label": compartment_label,
            "open_event_timestamps": [str(t) for t in open_event_timestamps],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in PILLBOX_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Adherence Rules): defense-in-depth guard, then
    # flag critical non-adherence if the most recent lid opening is more
    # than 48 hours old (or there are no recorded openings at all).
    def evaluate_adherence(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in PILLBOX_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached adherence evaluation stage')

        timestamps = [d for d in (_parse_timestamp(t) for t in record["open_event_timestamps"]) if d is not None]
        most_recent_open = max(timestamps) if timestamps else None
        if most_recent_open:
            hours_since_last_open = (datetime.now(timezone.utc) - most_recent_open).total_seconds() / 3600
        else:
            hours_since_last_open = math.inf
        critical_risk = hours_since_last_open > NON_ADHERENCE_WINDOW_HOURS

        return {"critical_risk": critical_risk, "hours_since_last_open": hours_since_last_open, "status": "CRITICAL_MEDICATION_NON_ADHERENCE" if critical_risk else "ADHERENT"}

    # Stage 3 (Integration): only reachable on critical non-adherence.
    def build_pharmacy_outreach_task(self, record, adherence_result):
        hours_display = f'{adherence_result["hours_since_last_open"]:.1f}' if math.isfinite(adherence_result["hours_since_last_open"]) else "NEVER_OPENED"
        return (
            f'PHARMACY-OUTREACH-TASK|{record["subject_id"]}|COMPARTMENT:{record["compartment_label"]}|HOURS_SINCE_LAST_OPEN:{hours_display}|'
            f"ACTION:PROACTIVE_TELEPHONIC_CHECK_IN|PRIORITY:HIGH|CREATED_AT:{iso_now()}"
        )

    # Stage 4 (Audit Telemetry): secure Splunk HEC compliance record
    # carrying the anonymized tracking fingerprint — the compartment label
    # (which may itself name the medication) is masked before logging.
    def build_splunk_event(self, record, adherence_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "smart-pillbox-adherence-auditor",
            "source": "hub6_edge_telemetry/smart_pillbox_adherence_auditor",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": adherence_result["critical_risk"],
                "status": adherence_result["status"],
                "hours_since_last_open": round(adherence_result["hours_since_last_open"], 1) if math.isfinite(adherence_result["hours_since_last_open"]) else None,
                "masked_compartment_label": mask_value(record["compartment_label"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_pillbox_data, patient_identifiers):
        record = self.ingest(raw_pillbox_data, patient_identifiers)
        adherence_result = self.evaluate_adherence(record)
        outreach_task = self.build_pharmacy_outreach_task(record, adherence_result) if adherence_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, adherence_result, "critical_non_adherence_escalated" if outreach_task else "adherent")
        return {"outreach_task": outreach_task, "status": adherence_result["status"], "splunk_event": splunk_event}
