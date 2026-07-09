"""Emergency Department Bed Capacity Predictor (Agent 2, Hub 2)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

CLINICAL_ALLOWLIST = ["triage_acuity", "chief_complaint_category", "age_bucket", "vitals", "comorbidities", "arrival_hour"]

HIGH_RISK_COMPLAINT_CATEGORIES = {"chest_pain", "stroke_symptoms", "sepsis", "respiratory_distress"}

ESI_ACUITY_SCORE = {1: 50, 2: 40, 3: 25, 4: 10, 5: 5}


def age_to_bucket(age):
    if age is None:
        return "unknown"
    if age < 5:
        return "pediatric"
    if age < 18:
        return "adolescent"
    if age < 65:
        return "adult"
    return "geriatric"


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EdBedCapacityPredictor:
    # Stage 1: strip direct identifiers, retain only allowlisted clinical fields
    # plus a one-way pseudonymous subject ID for downstream correlation.
    def redact(self, raw_encounter):
        if not isinstance(raw_encounter, dict):
            raise TypeError("raw_encounter must be a dict")

        mrn = raw_encounter.get("mrn")
        dob = raw_encounter.get("dob")
        age = raw_encounter.get("age")
        triage_acuity = raw_encounter.get("triage_acuity")
        chief_complaint_category = raw_encounter.get("chief_complaint_category")
        vitals = raw_encounter.get("vitals")
        comorbidities = raw_encounter.get("comorbidities")
        arrival_time = raw_encounter.get("arrival_time")

        if not mrn or not dob or not triage_acuity:
            raise ValueError("raw_encounter requires mrn, dob, and triage_acuity")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "triage_acuity": int(triage_acuity),
            "chief_complaint_category": chief_complaint_category or "unspecified",
            "age_bucket": age_to_bucket(age),
            "vitals": vitals or {},
            "comorbidities": comorbidities if isinstance(comorbidities, list) else [],
            "arrival_hour": datetime.fromisoformat(arrival_time.replace("Z", "+00:00")).hour if arrival_time else None,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in CLINICAL_ALLOWLIST:
                del record[key]
        return record

    # Stage 2: rule-based admission risk score, with a defense-in-depth check
    # that no un-allowlisted (potentially identifying) field reached this stage.
    def score(self, redacted_record):
        leaked = next((k for k in redacted_record if k != "subject_id" and k not in CLINICAL_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached scoring stage')

        risk_score = ESI_ACUITY_SCORE.get(redacted_record["triage_acuity"], 0)

        vitals = redacted_record["vitals"]
        heart_rate = vitals.get("heart_rate")
        spo2 = vitals.get("spo2")
        systolic_bp = vitals.get("systolic_bp")
        if heart_rate is not None and (heart_rate > 120 or heart_rate < 50):
            risk_score += 15
        if spo2 is not None and spo2 < 92:
            risk_score += 20
        if systolic_bp is not None and systolic_bp < 90:
            risk_score += 20

        if redacted_record["age_bucket"] == "geriatric":
            risk_score += 10
        if redacted_record["age_bucket"] == "pediatric":
            risk_score += 5

        if redacted_record["chief_complaint_category"] in HIGH_RISK_COMPLAINT_CATEGORIES:
            risk_score += 20
        risk_score += len(redacted_record["comorbidities"]) * 5

        if risk_score >= 70:
            risk_tier, recommended_unit = "high", "ICU"
        elif risk_score >= 40:
            risk_tier, recommended_unit = "medium", "MED_SURG_TELEMETRY"
        else:
            risk_tier, recommended_unit = "low", "OBSERVATION"

        return {**redacted_record, "risk_score": risk_score, "risk_tier": risk_tier, "recommended_unit": recommended_unit}

    # Stage 3: shape a UiPath Orchestrator queue-item payload for the
    # bed-reservation RPA robot to pick up and execute.
    def build_rpa_payload(self, scored_record):
        priority_map = {"high": "High", "medium": "Normal", "low": "Low"}
        now = datetime.now(timezone.utc)

        return {
            "queue_name": "ED_BED_RESERVATION_QUEUE",
            "priority": priority_map[scored_record["risk_tier"]],
            "reference": f'{scored_record["subject_id"]}-{int(now.timestamp() * 1000)}',
            "due_date": iso_now() if scored_record["risk_tier"] == "high" else None,
            "specific_content": {
                "subject_id": scored_record["subject_id"],
                "recommended_unit": scored_record["recommended_unit"],
                "risk_tier": scored_record["risk_tier"],
                "risk_score": scored_record["risk_score"],
                "chief_complaint_category": scored_record["chief_complaint_category"],
                "requested_at": iso_now(),
            },
        }

    # Stage 4: format a Splunk HTTP Event Collector (HEC) event for the
    # audit trail — pseudonymous ID and outcome metadata only, no PHI.
    def build_splunk_event(self, rpa_payload):
        content = rpa_payload["specific_content"]
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "ed-bed-capacity-predictor",
            "source": "hub2_clinical_operations/predictor",
            "sourcetype": "_json",
            "event": {
                "subject_id": content["subject_id"],
                "action": "ED_BED_RESERVATION_QUEUED",
                "risk_tier": content["risk_tier"],
                "risk_score": content["risk_score"],
                "recommended_unit": content["recommended_unit"],
                "queue_reference": rpa_payload["reference"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_encounter):
        redacted = self.redact(raw_encounter)
        scored = self.score(redacted)
        rpa_payload = self.build_rpa_payload(scored)
        splunk_event = self.build_splunk_event(rpa_payload)
        return {"rpa_payload": rpa_payload, "splunk_event": splunk_event}
