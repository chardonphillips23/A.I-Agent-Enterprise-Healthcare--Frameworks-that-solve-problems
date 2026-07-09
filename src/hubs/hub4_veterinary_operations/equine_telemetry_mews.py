"""Equine Telemetry MEWS (Agent 12, Hub 4)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

VITALS_ALLOWLIST = ["heart_rate", "respiration_rate", "temperature_celsius", "capillary_refill_time_seconds"]


def hash_subject_id(horse_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{horse_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Normal adult horse ranges: HR 28-44 bpm, RR 8-16/min, Temp 37.2-38.3°C,
# CRT < 2s. Heart rate >60 bpm and CRT >2s are the two most sensitive
# single indicators of a colic/shock crisis, so each is weighted heavily
# enough to cross the critical threshold on its own.
def score_heart_rate(hr):
    if hr <= 44:
        return 0
    if hr <= 60:
        return 2
    return 5


def score_respiration(rr):
    if rr <= 16:
        return 0
    if rr <= 24:
        return 1
    if rr <= 30:
        return 2
    return 3


def score_temperature(temp_c):
    if temp_c < 37:
        return 1
    if temp_c <= 38.5:
        return 0
    if temp_c <= 39.5:
        return 1
    return 2


def score_capillary_refill(crt_seconds):
    if crt_seconds <= 2:
        return 0
    return 5


class EquineTelemetryMews:
    # Stage 1 (Telemetry Ingestion): the raw horse_id is only used here to
    # derive a hashed subject_id; only the four vitals survive into the record.
    def ingest(self, raw_telemetry):
        if not isinstance(raw_telemetry, dict):
            raise TypeError("raw_telemetry must be a dict")
        horse_id = raw_telemetry.get("horse_id")
        heart_rate = raw_telemetry.get("heart_rate")
        respiration_rate = raw_telemetry.get("respiration_rate")
        temperature_celsius = raw_telemetry.get("temperature_celsius")
        capillary_refill_time = raw_telemetry.get("capillary_refill_time")

        if not horse_id:
            raise ValueError("raw_telemetry requires horse_id to derive a subject_id")
        if any(v is None for v in [heart_rate, respiration_rate, temperature_celsius, capillary_refill_time]):
            raise ValueError("raw_telemetry requires heart_rate, respiration_rate, temperature_celsius, and capillary_refill_time")

        record = {
            "subject_id": hash_subject_id(horse_id),
            "heart_rate": float(heart_rate),
            "respiration_rate": float(respiration_rate),
            "temperature_celsius": float(temperature_celsius),
            "capillary_refill_time_seconds": float(capillary_refill_time),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in VITALS_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & EEWS Scoring): defense-in-depth guard, then sum
    # the four subscores. A total of 5 or more is a critical colic-crisis risk.
    def compute_eews(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in VITALS_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached scoring stage')

        subscores = {
            "heart_rate_score": score_heart_rate(record["heart_rate"]),
            "respiration_score": score_respiration(record["respiration_rate"]),
            "temperature_score": score_temperature(record["temperature_celsius"]),
            "capillary_refill_score": score_capillary_refill(record["capillary_refill_time_seconds"]),
        }
        eews_score = sum(subscores.values())

        return {"eews_score": eews_score, "critical_risk": eews_score >= 5, "subscores": subscores}

    # Stage 3 (Integration): PIMS patient dashboard vitals update — runs on
    # every reading, since the dashboard reflects continuous stall monitoring.
    def build_dashboard_vitals_update(self, record, eews_result):
        status = "CRITICAL" if eews_result["critical_risk"] else "STABLE"
        return (
            f'PIMS-VITALS|{record["subject_id"]}|HR:{record["heart_rate"]}bpm|RR:{record["respiration_rate"]}/min|'
            f'TEMP:{record["temperature_celsius"]}C|CRT:{record["capillary_refill_time_seconds"]}s|EEWS:{eews_result["eews_score"]}|STATUS:{status}'
        )

    # Stage 4a (Field Surgeon Broadcast): only built when EEWS >= 5.
    def build_field_surgeon_broadcast(self, record, eews_result):
        return {
            "channel": "large_animal_field_surgeon_sms",
            "priority": "immediate",
            "subject_id": record["subject_id"],
            "headline": f'EEWS {eews_result["eews_score"]} — possible colic crisis, immediate evaluation required',
            "vitals_summary": f'HR {record["heart_rate"]}bpm, RR {record["respiration_rate"]}/min, Temp {record["temperature_celsius"]}C, CRT {record["capillary_refill_time_seconds"]}s',
            "requested_action": "Dispatch on-call large-animal field surgeon to the stall immediately; prepare for potential colic workup/surgical consult.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk SIEM log on every reading.
    def build_splunk_event(self, record, eews_result, surgeon_broadcast):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "equine-telemetry-mews",
            "source": "hub4_veterinary_operations/equine_telemetry_mews",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": "critical_field_surgeon_paged" if surgeon_broadcast else "routine_monitoring",
                "eews_score": eews_result["eews_score"],
                "critical_risk": eews_result["critical_risk"],
                "masked_vitals": {
                    "heart_rate": mask_value(record["heart_rate"]),
                    "respiration_rate": mask_value(record["respiration_rate"]),
                    "temperature_celsius": mask_value(record["temperature_celsius"]),
                    "capillary_refill_time_seconds": mask_value(record["capillary_refill_time_seconds"]),
                },
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_telemetry):
        record = self.ingest(raw_telemetry)
        eews_result = self.compute_eews(record)
        dashboard_update = self.build_dashboard_vitals_update(record, eews_result)
        surgeon_broadcast = self.build_field_surgeon_broadcast(record, eews_result) if eews_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, eews_result, surgeon_broadcast)
        return {
            "dashboard_update": dashboard_update,
            "surgeon_broadcast": surgeon_broadcast,
            "splunk_event": splunk_event,
            "eews_score": eews_result["eews_score"],
            "critical_risk": eews_result["critical_risk"],
        }
