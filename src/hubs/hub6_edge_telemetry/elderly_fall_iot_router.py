"""Elderly Fall IoT Router (Agent 23, Hub 6)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

ACCELEROMETER_ALLOWLIST = ["g_force_value", "no_motion_duration_seconds", "latitude", "longitude"]

FALL_G_FORCE_THRESHOLD = 4.5
FALL_NO_MOTION_THRESHOLD_SECONDS = 60


def hash_tracking_id(device_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{device_id}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ElderlyFallIotRouter:
    # Stage 1 (Accelerometer Ingestion): the raw device_id is only used to
    # derive a hashed tracking_id; g-force, motion duration, and location
    # survive — location is needed verbatim for Stage 3's EMS dispatch.
    def ingest(self, raw_accelerometer_data):
        if not isinstance(raw_accelerometer_data, dict):
            raise TypeError("raw_accelerometer_data must be a dict")
        device_id = raw_accelerometer_data.get("device_id")
        g_force_value = raw_accelerometer_data.get("g_force_value")
        no_motion_duration_seconds = raw_accelerometer_data.get("no_motion_duration_seconds")
        latitude = raw_accelerometer_data.get("latitude")
        longitude = raw_accelerometer_data.get("longitude")
        if not device_id:
            raise ValueError("raw_accelerometer_data requires device_id to derive a tracking_id")
        if g_force_value is None or no_motion_duration_seconds is None:
            raise ValueError("raw_accelerometer_data requires g_force_value and no_motion_duration_seconds")

        record = {
            "tracking_id": hash_tracking_id(device_id),
            "g_force_value": float(g_force_value),
            "no_motion_duration_seconds": float(no_motion_duration_seconds),
            "latitude": float(latitude) if latitude is not None else None,
            "longitude": float(longitude) if longitude is not None else None,
        }

        for key in list(record.keys()):
            if key != "tracking_id" and key not in ACCELEROMETER_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Fall Detection Rules): defense-in-depth guard,
    # then flag a fall when a hard impact is followed by sustained stillness.
    def detect_fall(self, record):
        leaked = next((k for k in record if k != "tracking_id" and k not in ACCELEROMETER_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached detection stage')

        critical_risk = record["g_force_value"] >= FALL_G_FORCE_THRESHOLD and record["no_motion_duration_seconds"] >= FALL_NO_MOTION_THRESHOLD_SECONDS
        return {"critical_risk": critical_risk, "status": "ELDERLY_FALL_DETECTED" if critical_risk else "NO_FALL_DETECTED"}

    # Stage 3 (Integration): only reachable on a detected fall. Exact
    # coordinates are required here — EMS cannot dispatch without them.
    def build_ems_dispatch_ticket(self, record, fall_result):
        return (
            f'EMS-DISPATCH-TICKET|TRACKING_ID:{record["tracking_id"]}|STATUS:{fall_result["status"]}|G_FORCE:{record["g_force_value"]}|'
            f'NO_MOTION_SEC:{record["no_motion_duration_seconds"]}|LAT:{record["latitude"]}|LON:{record["longitude"]}|'
            f"DISPATCH_PRIORITY:IMMEDIATE|CREATED_AT:{iso_now()}"
        )

    # Stage 4 (Audit Telemetry): tokenized Splunk record on every reading —
    # coordinates are reduced to ~11km precision rather than logged raw, so
    # the SIEM audit trail never carries an exact address-level location.
    def build_splunk_event(self, record, fall_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "elderly-fall-iot-router",
            "source": "hub6_edge_telemetry/elderly_fall_iot_router",
            "sourcetype": "_json",
            "event": {
                "tracking_id": record["tracking_id"],
                "action": outcome,
                "critical_risk": fall_result["critical_risk"],
                "g_force_value": record["g_force_value"],
                "no_motion_duration_seconds": record["no_motion_duration_seconds"],
                "approximate_latitude": round(record["latitude"], 1) if record["latitude"] is not None else None,
                "approximate_longitude": round(record["longitude"], 1) if record["longitude"] is not None else None,
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_accelerometer_data):
        record = self.ingest(raw_accelerometer_data)
        fall_result = self.detect_fall(record)
        ems_dispatch_ticket = self.build_ems_dispatch_ticket(record, fall_result) if fall_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, fall_result, "ems_dispatched" if ems_dispatch_ticket else "no_fall_detected")
        return {"ems_dispatch_ticket": ems_dispatch_ticket, "status": fall_result["status"], "splunk_event": splunk_event}
