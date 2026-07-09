"""Nitrous Oxide Safety Sentinel (Agent 30, Hub 7)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

SENSOR_ALLOWLIST = ["ppm_value", "sustained_minutes_above_threshold"]

NITROUS_PPM_THRESHOLD = 25
NITROUS_SUSTAINED_MINUTES_THRESHOLD = 5


def hash_asset_id(sensor_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{sensor_id}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NitrousOxideSafetySentinel:
    # Stage 1 (Environmental Sensor Ingestion): the raw sensor_id is only
    # used to derive a hashed asset_id; only the ppm reading and sustained
    # duration survive into the record.
    def ingest(self, raw_sensor_data):
        if not isinstance(raw_sensor_data, dict):
            raise TypeError("raw_sensor_data must be a dict")
        sensor_id = raw_sensor_data.get("sensor_id")
        ppm_value = raw_sensor_data.get("ppm_value")
        sustained_minutes_above_threshold = raw_sensor_data.get("sustained_minutes_above_threshold")
        if not sensor_id:
            raise ValueError("raw_sensor_data requires sensor_id to derive an asset_id")
        if ppm_value is None or sustained_minutes_above_threshold is None:
            raise ValueError("raw_sensor_data requires ppm_value and sustained_minutes_above_threshold")

        record = {
            "asset_id": hash_asset_id(sensor_id),
            "ppm_value": float(ppm_value),
            "sustained_minutes_above_threshold": float(sustained_minutes_above_threshold),
        }

        for key in list(record.keys()):
            if key != "asset_id" and key not in SENSOR_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Environmental Safety Rules): defense-in-depth guard, then
    # flag a hazardous leak only when the concentration exceeds the safe
    # threshold continuously for more than 5 minutes.
    def evaluate_gas_safety(self, record):
        leaked = next((k for k in record if k != "asset_id" and k not in SENSOR_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached gas safety evaluation stage')

        hazardous_leak = record["ppm_value"] > NITROUS_PPM_THRESHOLD and record["sustained_minutes_above_threshold"] > NITROUS_SUSTAINED_MINUTES_THRESHOLD
        return {"hazardous_leak": hazardous_leak, "status": "HAZARDOUS_NITROUS_LEAK" if hazardous_leak else "SAFE"}

    # Stage 3 (Integration): only reachable on a hazardous leak. A
    # fail-safe command directed at the manifold gas lines.
    def build_manifold_shutdown_command(self, record, safety_result):
        return (
            f'MANIFOLD-SHUTDOWN-COMMAND|{record["asset_id"]}|STATUS:{safety_result["status"]}|PPM:{record["ppm_value"]}|'
            f'SUSTAINED_MIN:{record["sustained_minutes_above_threshold"]}|ACTION:FAIL_SAFE_GAS_LINE_SHUTOFF|CREATED_AT:{iso_now()}'
        )

    # Stage 4a (Facilities Intercept): only reachable on a hazardous leak.
    def build_facilities_alarm_ticket(self, record, safety_result):
        return {
            "channel": "facilities_environmental_alarm",
            "priority": "critical_hazard",
            "asset_id": record["asset_id"],
            "headline": f'HAZARDOUS NITROUS OXIDE LEAK: {record["ppm_value"]}ppm sustained for {record["sustained_minutes_above_threshold"]} minutes',
            "requested_action": "Evacuate the surgical suite immediately, confirm manifold shutoff engaged, and ventilate the space before re-entry.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): structured Splunk HEC compliance log on
    # every reading. No patient identifiers are involved in this agent —
    # ppm_value and asset_id are equipment/environmental telemetry, not PHI.
    def build_splunk_event(self, record, safety_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "nitrous-oxide-safety-sentinel",
            "source": "hub7_dental_operations/nitrous_oxide_safety_sentinel",
            "sourcetype": "_json",
            "event": {
                "asset_id": record["asset_id"],
                "action": outcome,
                "hazardous_leak": safety_result["hazardous_leak"],
                "ppm_value": record["ppm_value"],
                "sustained_minutes_above_threshold": record["sustained_minutes_above_threshold"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_sensor_data):
        record = self.ingest(raw_sensor_data)
        safety_result = self.evaluate_gas_safety(record)

        if safety_result["hazardous_leak"]:
            shutdown_command = self.build_manifold_shutdown_command(record, safety_result)
            alarm_ticket = self.build_facilities_alarm_ticket(record, safety_result)
            splunk_event = self.build_splunk_event(record, safety_result, "hazardous_leak_shutdown_triggered")
            return {"shutdown_command": shutdown_command, "alarm_ticket": alarm_ticket, "splunk_event": splunk_event}

        splunk_event = self.build_splunk_event(record, safety_result, "safe_levels")
        return {"shutdown_command": None, "alarm_ticket": None, "splunk_event": splunk_event}
