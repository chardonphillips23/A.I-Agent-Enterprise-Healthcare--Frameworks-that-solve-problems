"""Substance Compliance Guard (Agent 8, Hub 3)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

RX_ALLOWLIST = ["drug_name", "dosage", "days_supply", "requested_fill_date", "prior_fill_on_record", "percent_previous_supply_exhausted"]

SCHEDULE_II_DRUGS = {"oxycodone", "fentanyl", "morphine", "hydromorphone", "methadone"}

# Mock state PDMP (Prescription Drug Monitoring Program) database, keyed by
# the patient's raw MRN — this lookup can only happen in Stage 1, since
# that's the only stage still holding the raw identifier.
MOCK_PDMP_DATABASE = {
    "MRN-990211": {"oxycodone": {"last_fill_date": "2026-06-20", "days_supply": 30}},
    "MRN-990212": {"oxycodone": {"last_fill_date": "2026-05-01", "days_supply": 30}},
}


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SubstanceComplianceGuard:
    # Stage 1 (Rx Ingestion): look up the mock PDMP record while the raw MRN
    # is still available, then carry forward only the derived compliance
    # fields (percent of prior supply exhausted) plus a hashed subject_id.
    def ingest(self, raw_request, patient_identifiers):
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        raw_request = raw_request or {}
        drug_name = raw_request.get("drug_name")
        dosage = raw_request.get("dosage")
        days_supply = raw_request.get("days_supply")
        requested_fill_date = raw_request.get("requested_fill_date")
        if not drug_name or not dosage or not days_supply or not requested_fill_date:
            raise ValueError("raw_request requires drug_name, dosage, days_supply, and requested_fill_date")

        prior_fill_record = MOCK_PDMP_DATABASE.get(mrn, {}).get(drug_name.lower())
        percent_previous_supply_exhausted = None
        if prior_fill_record:
            requested_dt = datetime.fromisoformat(requested_fill_date)
            last_fill_dt = datetime.fromisoformat(prior_fill_record["last_fill_date"])
            days_since_last_fill = (requested_dt - last_fill_dt).days
            percent_previous_supply_exhausted = max(0, min((days_since_last_fill / prior_fill_record["days_supply"]) * 100, 100))

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "drug_name": drug_name,
            "dosage": dosage,
            "days_supply": float(days_supply),
            "requested_fill_date": requested_fill_date,
            "prior_fill_on_record": bool(prior_fill_record),
            "percent_previous_supply_exhausted": percent_previous_supply_exhausted,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in RX_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (DEA/PDMP Compliance Rules): defense-in-depth guard, then flag
    # a breach if a Schedule II refill is requested before 85% of the prior
    # fill's days-supply has elapsed.
    def check_dea_compliance(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in RX_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached compliance stage')

        is_schedule_ii = record["drug_name"].lower() in SCHEDULE_II_DRUGS
        breach = False
        reason = None

        if is_schedule_ii and record["prior_fill_on_record"] and record["percent_previous_supply_exhausted"] < 85:
            breach = True
            reason = (
                f'Refill requested at {record["percent_previous_supply_exhausted"]:.1f}% of previous {record["drug_name"]} '
                "supply exhausted; DEA/PDMP policy requires at least 85% exhaustion before an early refill."
            )

        return {"is_schedule_ii": is_schedule_ii, "breach": breach, "reason": reason, "cleared": not breach}

    # Stage 3 (Integration): only reachable when Stage 2 clears the refill.
    # Shapes a FHIR MedicationRequest carrying mock provenance-compliance
    # extensions confirming the PDMP check was performed.
    def build_fhir_medication_request(self, record):
        return {
            "resourceType": "MedicationRequest",
            "status": "active",
            "intent": "order",
            "subject": {"reference": f'Patient/{record["subject_id"]}'},
            "medicationCodeableConcept": {"text": record["drug_name"]},
            "dosageInstruction": [{"text": record["dosage"]}],
            "dispenseRequest": {"expectedSupplyDuration": {"value": record["days_supply"], "unit": "d"}},
            "extension": [{"url": "urn:mock:dea-provenance-verified", "valueBoolean": True}],
            "meta": {"tag": [{"system": "urn:mock:pdmp-verified", "code": "cleared"}]},
        }

    # Stage 4a (DEA Audit Exception): only reachable on a compliance breach.
    def build_dea_audit_exception(self, record, compliance_result):
        return {
            "channel": "dea_compliance_exception_queue",
            "priority": "active_audit_exception",
            "subject_id": record["subject_id"],
            "drug_name": record["drug_name"],
            "headline": "DEA compliance breach: early refill request blocked",
            "reason": compliance_result["reason"],
            "requested_action": "Do not dispense. Escalate to the pharmacist-in-charge for manual PDMP review before any further action.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): tokenized Splunk record — the drug name is
    # masked before it ever reaches the log.
    def build_splunk_event(self, record, compliance_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "substance-compliance-guard",
            "source": "hub3_pharmacy_logistics/substance_compliance_guard",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "drug_name": mask_value(record["drug_name"]),
                "is_schedule_ii": compliance_result["is_schedule_ii"],
                "breach": compliance_result["breach"],
                "percent_previous_supply_exhausted": record["percent_previous_supply_exhausted"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_request, patient_identifiers):
        record = self.ingest(raw_request, patient_identifiers)
        compliance_result = self.check_dea_compliance(record)

        if compliance_result["cleared"]:
            fhir_payload = self.build_fhir_medication_request(record)
            splunk_event = self.build_splunk_event(record, compliance_result, "cleared_and_dispensed")
            return {"fhir_payload": fhir_payload, "dea_exception": None, "splunk_event": splunk_event}

        dea_exception = self.build_dea_audit_exception(record, compliance_result)
        splunk_event = self.build_splunk_event(record, compliance_result, "blocked_dea_exception")
        return {"fhir_payload": None, "dea_exception": dea_exception, "splunk_event": splunk_event}
