"""Cardiac Arrhythmia Detector (Agent 21, Hub 6)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

TELEMETRY_ALLOWLIST = ["heart_rate", "rhythm_status"]


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CardiacArrhythmiaDetector:
    # Stage 1 (Wearable Telemetry Ingestion): mrn/dob are only used to
    # derive a hashed subject_id; only heart_rate and rhythm_status survive.
    def ingest(self, raw_telemetry):
        if not isinstance(raw_telemetry, dict):
            raise TypeError("raw_telemetry must be a dict")
        mrn = raw_telemetry.get("mrn")
        dob = raw_telemetry.get("dob")
        heart_rate = raw_telemetry.get("heart_rate")
        rhythm_status = raw_telemetry.get("rhythm_status")
        if not mrn or not dob:
            raise ValueError("raw_telemetry requires mrn and dob to derive a subject_id")
        if heart_rate is None or not rhythm_status:
            raise ValueError("raw_telemetry requires heart_rate and rhythm_status")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "heart_rate": float(heart_rate),
            "rhythm_status": rhythm_status,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in TELEMETRY_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Cardiac Stability Rules): defense-in-depth
    # guard, then flag ventricular tachycardia when heart rate exceeds
    # 160bpm on an unstable rhythm.
    def evaluate_cardiac_stability(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in TELEMETRY_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached stability evaluation stage')

        critical_risk = record["heart_rate"] > 160 and record["rhythm_status"] == "unstable"
        return {"critical_risk": critical_risk, "telemetry_status": "VENTRICULAR_TACHYCARDIA" if critical_risk else "STABLE"}

    # Stage 3 (Integration): HL7 v2 ORU^R01 cardiology telemetry alert —
    # runs on every reading, since telemetry is streamed continuously.
    def build_oru_telemetry_alert(self, record, stability_result):
        now = datetime.now(timezone.utc)
        hl7_timestamp = now.strftime("%Y%m%dT%H%M%S")
        message_id = f"MSG{int(now.timestamp() * 1000)}"
        observation_status = "A" if stability_result["critical_risk"] else "F"

        segments = [
            f"MSH|^~\\&|CARDIAC_ARRHYTHMIA_DETECTOR|WEARABLE|CARDIOLOGY_MONITORING|HOSPITAL|{hl7_timestamp}||ORU^R01|{message_id}|P|2.5",
            f'PID|1||{record["subject_id"]}',
            "OBR|1|||CARDIAC_TELEMETRY^Cardiac Rhythm Telemetry",
            f'OBX|1|NM|8867-4^Heart Rate||{record["heart_rate"]}|/min|||||{observation_status}',
            f'OBX|2|ST|RHYTHM^Rhythm Status||{record["rhythm_status"]}||||||{observation_status}',
            f'OBX|3|ST|STATUS^Telemetry Status||{stability_result["telemetry_status"]}||||||{observation_status}',
        ]

        return "\r".join(segments)

    # Stage 4a (Cardiologist Sentinel Intercept): only built on critical risk.
    def build_cardiologist_pager_alert(self, record):
        return {
            "channel": "emergency_cardiologist_pager",
            "priority": "stat",
            "subject_id": record["subject_id"],
            "headline": f'STAT: Ventricular tachycardia suspected — HR {record["heart_rate"]}bpm, rhythm {record["rhythm_status"]}',
            "requested_action": "Immediate cardiologist evaluation required; prepare for potential emergency intervention.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk event on every reading.
    def build_splunk_event(self, record, stability_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "cardiac-arrhythmia-detector",
            "source": "hub6_edge_telemetry/cardiac_arrhythmia_detector",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": stability_result["critical_risk"],
                "telemetry_status": stability_result["telemetry_status"],
                "masked_heart_rate": mask_value(record["heart_rate"]),
                "masked_rhythm_status": mask_value(record["rhythm_status"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_telemetry):
        record = self.ingest(raw_telemetry)
        stability_result = self.evaluate_cardiac_stability(record)
        oru_message = self.build_oru_telemetry_alert(record, stability_result)
        pager_alert = self.build_cardiologist_pager_alert(record) if stability_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, stability_result, "critical_cardiologist_paged" if pager_alert else "routine_monitoring")
        return {
            "oru_message": oru_message,
            "pager_alert": pager_alert,
            "splunk_event": splunk_event,
            "telemetry_status": stability_result["telemetry_status"],
            "critical_risk": stability_result["critical_risk"],
        }
