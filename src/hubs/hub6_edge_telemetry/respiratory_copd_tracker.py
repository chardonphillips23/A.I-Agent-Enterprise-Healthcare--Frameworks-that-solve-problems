"""Respiratory COPD Tracker (Agent 24, Hub 6)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

OXIMETER_ALLOWLIST = ["historical_spo2"]

TREND_WINDOW_HOURS = 72
CHRONIC_DISTRESS_SPO2_THRESHOLD = 88


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RespiratoryCopdTracker:
    # Stage 1 (Oximeter History Ingestion): mrn/dob are only used to derive
    # a hashed subject_id; only the rolling SpO2 history survives.
    def ingest(self, raw_history):
        if not isinstance(raw_history, dict):
            raise TypeError("raw_history must be a dict")
        mrn = raw_history.get("mrn")
        dob = raw_history.get("dob")
        historical_spo2 = raw_history.get("historical_spo2")
        if not mrn or not dob:
            raise ValueError("raw_history requires mrn and dob to derive a subject_id")
        if not isinstance(historical_spo2, list) or len(historical_spo2) == 0:
            raise ValueError("raw_history requires a non-empty historical_spo2 list")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "historical_spo2": [float(v) for v in historical_spo2],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in OXIMETER_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & 3-Day Trend Analysis): defense-in-depth guard,
    # then flag chronic distress only if a full 72-hour (hourly-sampled)
    # window is available and every reading in it stays below 88%.
    def evaluate_trend(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in OXIMETER_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached trend evaluation stage')

        recent_window = record["historical_spo2"][-TREND_WINDOW_HOURS:]
        sufficient_data = len(recent_window) >= TREND_WINDOW_HOURS
        all_below_threshold = sufficient_data and all(reading < CHRONIC_DISTRESS_SPO2_THRESHOLD for reading in recent_window)
        average_spo2 = sum(recent_window) / len(recent_window)

        return {
            "critical_risk": all_below_threshold,
            "sufficient_data": sufficient_data,
            "average_spo2": average_spo2,
            "status": "CHRONIC_RESPIRATORY_DISTRESS" if all_below_threshold else "STABLE",
        }

    # Stage 3 (Integration): only reachable on a confirmed chronic-distress
    # trend. Books a preventive home-health telehealth nurse appointment.
    def build_telehealth_booking_payload(self, record, trend_result):
        return (
            f'TELEHEALTH-BOOKING|{record["subject_id"]}|APPOINTMENT_TYPE:HOME_HEALTH_NURSE_PREVENTIVE|REASON:CHRONIC_RESPIRATORY_DISTRESS|'
            f'AVG_SPO2:{trend_result["average_spo2"]:.1f}|REQUESTED_WINDOW:NEXT_24_HOURS|CREATED_AT:{iso_now()}'
        )

    # Stage 4 (Audit Telemetry): masked Splunk HEC event carrying only the
    # trend summary, never the raw 72-reading history.
    def build_splunk_event(self, record, trend_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "respiratory-copd-tracker",
            "source": "hub6_edge_telemetry/respiratory_copd_tracker",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": trend_result["critical_risk"],
                "status": trend_result["status"],
                "average_spo2": round(trend_result["average_spo2"], 1),
                "sufficient_data": trend_result["sufficient_data"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_history):
        record = self.ingest(raw_history)
        trend_result = self.evaluate_trend(record)
        booking_payload = self.build_telehealth_booking_payload(record, trend_result) if trend_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, trend_result, "chronic_distress_booking_triggered" if booking_payload else "stable_trend")
        return {"booking_payload": booking_payload, "status": trend_result["status"], "splunk_event": splunk_event}
