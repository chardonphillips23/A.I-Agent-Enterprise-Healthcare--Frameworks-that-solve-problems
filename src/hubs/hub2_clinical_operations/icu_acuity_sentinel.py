"""ICU Acuity Sentinel (Agent 6, Hub 2)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

VITALS_ALLOWLIST = ["respiration_rate", "heart_rate", "systolic_bp", "temperature_celsius"]


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Modified Early Warning Score subscore brackets.
def score_respiration(rr):
    if rr <= 8:
        return 3
    if rr <= 14:
        return 0
    if rr <= 20:
        return 1
    if rr <= 29:
        return 2
    return 3


def score_heart_rate(hr):
    if hr <= 40:
        return 2
    if hr <= 50:
        return 1
    if hr <= 100:
        return 0
    if hr <= 110:
        return 1
    if hr <= 129:
        return 2
    return 3


def score_systolic_bp(sbp):
    if sbp <= 70:
        return 3
    if sbp <= 80:
        return 2
    if sbp <= 100:
        return 1
    if sbp <= 199:
        return 0
    return 2


def score_temperature(temp_c):
    if temp_c < 35:
        return 2
    if temp_c < 38.5:
        return 0
    return 2


class IcuAcuitySentinel:
    # Stage 1 (Vitals Ingestion): retain only the four MEWS input vitals plus
    # a one-way pseudonymous subject ID. Any raw text/object fields not on
    # the allowlist are dropped before the record leaves this function.
    def ingest(self, raw_vitals):
        if not isinstance(raw_vitals, dict):
            raise TypeError("raw_vitals must be a dict")
        mrn = raw_vitals.get("mrn")
        dob = raw_vitals.get("dob")
        respiration_rate = raw_vitals.get("respiration_rate")
        heart_rate = raw_vitals.get("heart_rate")
        systolic_bp = raw_vitals.get("systolic_bp")
        temperature_celsius = raw_vitals.get("temperature_celsius")

        if not mrn or not dob:
            raise ValueError("raw_vitals requires mrn and dob to derive a subject_id")
        if any(v is None for v in [respiration_rate, heart_rate, systolic_bp, temperature_celsius]):
            raise ValueError("raw_vitals requires respiration_rate, heart_rate, systolic_bp, and temperature_celsius")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "respiration_rate": float(respiration_rate),
            "heart_rate": float(heart_rate),
            "systolic_bp": float(systolic_bp),
            "temperature_celsius": float(temperature_celsius),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in VITALS_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & MEWS Scoring): defense-in-depth guard, then sum
    # the four MEWS subscores. A total of 5 or more is a critical risk.
    def compute_mews(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in VITALS_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached scoring stage')

        subscores = {
            "respiration_score": score_respiration(record["respiration_rate"]),
            "heart_rate_score": score_heart_rate(record["heart_rate"]),
            "systolic_bp_score": score_systolic_bp(record["systolic_bp"]),
            "temperature_score": score_temperature(record["temperature_celsius"]),
        }
        mews_score = sum(subscores.values())

        return {"mews_score": mews_score, "critical_risk": mews_score >= 5, "subscores": subscores}

    # Stage 3 (Integration): shape an HL7 v2 ORU^R01 telemetry message —
    # this runs on every reading, since continuous vitals monitoring feeds
    # are sent regardless of risk level.
    def build_hl7_oru_message(self, record, mews_result):
        now = datetime.now(timezone.utc)
        hl7_timestamp = now.strftime("%Y%m%dT%H%M%S")
        message_id = f"MSG{int(now.timestamp() * 1000)}"
        observation_status = "A" if mews_result["critical_risk"] else "F"

        segments = [
            f"MSH|^~\\&|ICU_ACUITY_SENTINEL|HOSPITAL|CLINICAL_MONITORING|HOSPITAL|{hl7_timestamp}||ORU^R01|{message_id}|P|2.5",
            f'PID|1||{record["subject_id"]}',
            "OBR|1|||MEWS^Modified Early Warning Score",
            f'OBX|1|NM|9279-1^Respiratory Rate||{record["respiration_rate"]}|/min|||||F',
            f'OBX|2|NM|8867-4^Heart Rate||{record["heart_rate"]}|/min|||||F',
            f'OBX|3|NM|8480-6^Systolic Blood Pressure||{record["systolic_bp"]}|mm[Hg]|||||F',
            f'OBX|4|NM|8310-5^Body Temperature||{record["temperature_celsius"]}|Cel|||||F',
            f'OBX|5|NM|MEWS^MEWS Total Score||{mews_result["mews_score"]}||||||{observation_status}',
        ]

        return "\r".join(segments)

    # Stage 4a (Clinical Sentinel Intercept): only built when MEWS >= 5.
    def build_pager_alert(self, record, mews_result):
        return {
            "channel": "physician_pager",
            "priority": "stat",
            "subject_id": record["subject_id"],
            "headline": f'STAT: MEWS score {mews_result["mews_score"]} — critical deterioration risk',
            "vitals_summary": f'RR {record["respiration_rate"]}, HR {record["heart_rate"]}, SBP {record["systolic_bp"]}, Temp {record["temperature_celsius"]}°C',
            "requested_action": "Bedside physician assessment required immediately.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): Splunk HEC event on every reading; vitals
    # are masked so the log carries no plaintext physiological readings.
    def build_splunk_event(self, record, mews_result, pager_alert):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "icu-acuity-sentinel",
            "source": "hub2_clinical_operations/icu_acuity_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": "critical_pager_triggered" if pager_alert else "routine_monitoring",
                "mews_score": mews_result["mews_score"],
                "critical_risk": mews_result["critical_risk"],
                "masked_vitals": {
                    "respiration_rate": mask_value(record["respiration_rate"]),
                    "heart_rate": mask_value(record["heart_rate"]),
                    "systolic_bp": mask_value(record["systolic_bp"]),
                    "temperature_celsius": mask_value(record["temperature_celsius"]),
                },
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_vitals):
        record = self.ingest(raw_vitals)
        mews_result = self.compute_mews(record)
        hl7_message = self.build_hl7_oru_message(record, mews_result)
        pager_alert = self.build_pager_alert(record, mews_result) if mews_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(record, mews_result, pager_alert)
        return {
            "hl7_message": hl7_message,
            "pager_alert": pager_alert,
            "splunk_event": splunk_event,
            "mews_score": mews_result["mews_score"],
            "critical_risk": mews_result["critical_risk"],
        }
