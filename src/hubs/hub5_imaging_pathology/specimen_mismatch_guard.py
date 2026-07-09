"""Specimen Mismatch Guard (Agent 19, Hub 5)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

SPECIMEN_ALLOWLIST = ["anatomical_site", "tissue_code", "scheduled_anatomical_site", "scheduled_procedure"]


def hash_tracking_id(specimen_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{specimen_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize(s):
    return str(s).lower().strip()


class SpecimenMismatchGuard:
    # Stage 1 (Barcode & Booking Ingestion): the raw specimen_id is only used
    # to derive a hashed tracking_id; site/procedure fields from both the
    # barcode scan and the surgical booking feed survive for cross-checking.
    def ingest(self, barcode_data, surgical_booking):
        barcode_data = barcode_data or {}
        specimen_id = barcode_data.get("specimen_id")
        anatomical_site = barcode_data.get("anatomical_site")
        tissue_code = barcode_data.get("tissue_code")
        if not specimen_id:
            raise ValueError("barcode_data requires specimen_id to derive a tracking_id")
        if not anatomical_site or not tissue_code:
            raise ValueError("barcode_data requires anatomical_site and tissue_code")
        surgical_booking = surgical_booking or {}
        scheduled_anatomical_site = surgical_booking.get("scheduled_anatomical_site")
        scheduled_procedure = surgical_booking.get("scheduled_procedure")
        if not scheduled_anatomical_site or not scheduled_procedure:
            raise ValueError("surgical_booking requires scheduled_anatomical_site and scheduled_procedure")

        record = {
            "tracking_id": hash_tracking_id(specimen_id),
            "anatomical_site": anatomical_site,
            "tissue_code": tissue_code,
            "scheduled_anatomical_site": scheduled_anatomical_site,
            "scheduled_procedure": scheduled_procedure,
        }

        for key in list(record.keys()):
            if key != "tracking_id" and key not in SPECIMEN_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Match Verification): defense-in-depth guard, then compare the
    # barcode's anatomical site against the live surgical itinerary.
    def verify_match(self, record):
        leaked = next((k for k in record if k != "tracking_id" and k not in SPECIMEN_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached verification stage')

        mismatch = normalize(record["anatomical_site"]) != normalize(record["scheduled_anatomical_site"])
        return {"mismatch": mismatch, "cleared": not mismatch}

    # Stage 3 (Integration): a hard-block hold payload on mismatch, or a
    # cleared-for-processing payload when the site matches.
    def build_lab_dashboard_payload(self, record, match_result):
        if match_result["mismatch"]:
            return {
                "payload_type": "lab_dashboard_hard_block_hold",
                "tracking_id": record["tracking_id"],
                "status": "HELD_MISMATCH_EXCEPTION",
                "barcode_site": record["anatomical_site"],
                "scheduled_site": record["scheduled_anatomical_site"],
                "requested_action": "Processing hard-blocked. Do not proceed until specimen identity is manually reconciled against the surgical record.",
                "held_at": iso_now(),
            }
        return {
            "payload_type": "lab_dashboard_cleared_for_processing",
            "tracking_id": record["tracking_id"],
            "status": "VERIFIED_MATCH",
            "anatomical_site": record["anatomical_site"],
            "cleared_at": iso_now(),
        }

    # Stage 4a (Cleanroom Terminal Alarm): only reachable on a mismatch.
    def build_cleanroom_alarm_ticket(self, record):
        return {
            "channel": "cleanroom_terminal_alarm",
            "priority": "catastrophic_exception",
            "tracking_id": record["tracking_id"],
            "headline": "CATASTROPHIC SPECIMEN MISMATCH: barcode site does not match surgical itinerary",
            "detail": f'Specimen labeled "{record["anatomical_site"]}" (tissue code {record["tissue_code"]}) conflicts with the active surgical booking for "{record["scheduled_anatomical_site"]}" ({record["scheduled_procedure"]}).',
            "requested_action": "Sound the audible cleanroom terminal alarm. Halt all specimen processing immediately and escalate to the surgical team and lab director for manual identity reconciliation.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk audit event on every check.
    def build_splunk_event(self, record, match_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "specimen-mismatch-guard",
            "source": "hub5_imaging_pathology/specimen_mismatch_guard",
            "sourcetype": "_json",
            "event": {
                "tracking_id": record["tracking_id"],
                "action": outcome,
                "mismatch": match_result["mismatch"],
                "masked_barcode_site": mask_value(record["anatomical_site"]),
                "masked_scheduled_site": mask_value(record["scheduled_anatomical_site"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, barcode_data, surgical_booking):
        record = self.ingest(barcode_data, surgical_booking)
        match_result = self.verify_match(record)
        dashboard_payload = self.build_lab_dashboard_payload(record, match_result)
        alarm_ticket = self.build_cleanroom_alarm_ticket(record) if match_result["mismatch"] else None
        splunk_event = self.build_splunk_event(record, match_result, "catastrophic_mismatch_blocked" if match_result["mismatch"] else "verified_and_cleared")
        return {"dashboard_payload": dashboard_payload, "alarm_ticket": alarm_ticket, "splunk_event": splunk_event}
