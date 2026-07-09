"""Avian/Exotic Dosage Guard (Agent 13, Hub 4)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

RX_ALLOWLIST = ["species", "weight_grams", "drug_name", "requested_dosage_mg"]

# Mock micro-dosing safety ceilings for sub-1000g (avian/reptilian) patients.
MICRO_DOSING_SAFETY_THRESHOLDS = {
    "meloxicam": {"max_micrograms_per_gram": 0.2},
    "enrofloxacin": {"max_micrograms_per_gram": 10},
    "ivermectin": {"max_micrograms_per_gram": 0.2},
}


def hash_subject_id(owner_name, pet_name):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{owner_name}:{pet_name}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AvianExoticDosageGuard:
    # Stage 1 (Prescription Ingestion): owner/pet identifiers are only used
    # to derive a hashed subject_id; species, weight, drug, and dose survive.
    def ingest(self, raw_request, patient_identifiers):
        patient_identifiers = patient_identifiers or {}
        owner_name = patient_identifiers.get("owner_name")
        pet_name = patient_identifiers.get("pet_name")
        if not owner_name or not pet_name:
            raise ValueError("patient_identifiers requires owner_name and pet_name to derive a subject_id")
        raw_request = raw_request or {}
        species = raw_request.get("species")
        weight_grams = raw_request.get("weight_grams")
        drug_name = raw_request.get("drug_name")
        requested_dosage_mg = raw_request.get("requested_dosage_mg")
        if not species or not drug_name or weight_grams is None or requested_dosage_mg is None:
            raise ValueError("raw_request requires species, weight_grams, drug_name, and requested_dosage_mg")

        record = {
            "subject_id": hash_subject_id(owner_name, pet_name),
            "species": species,
            "weight_grams": float(weight_grams),
            "drug_name": drug_name,
            "requested_dosage_mg": float(requested_dosage_mg),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in RX_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Metabolic/Species Validation): defense-in-depth guard, then
    # apply the micro-dosing safety ceiling for sub-1000g patients. Fails
    # closed if the patient is a micro-patient but the drug has no threshold
    # on file, routing it to manual pharmacist review rather than approving.
    def validate_dosage(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in RX_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached validation stage')

        is_micro_patient = record["weight_grams"] < 1000
        threshold_entry = MICRO_DOSING_SAFETY_THRESHOLDS.get(record["drug_name"].lower())
        breach = False
        reason = None
        requested_micrograms_per_gram = None

        if is_micro_patient and threshold_entry:
            requested_micrograms_per_gram = (record["requested_dosage_mg"] * 1000) / record["weight_grams"]
            if requested_micrograms_per_gram > threshold_entry["max_micrograms_per_gram"]:
                breach = True
                reason = (
                    f'Requested dose ({requested_micrograms_per_gram:.2f} mcg/g) exceeds the micro-dosing safety ceiling of '
                    f'{threshold_entry["max_micrograms_per_gram"]} mcg/g for {record["drug_name"]} in a {record["weight_grams"]}g patient.'
                )
        elif is_micro_patient and not threshold_entry:
            breach = True
            reason = f'No micro-dosing safety threshold on file for "{record["drug_name"]}" in a sub-1000g patient — route to manual pharmacist review.'

        return {
            "is_micro_patient": is_micro_patient,
            "requested_micrograms_per_gram": requested_micrograms_per_gram,
            "breach": breach,
            "reason": reason,
            "cleared": not breach,
        }

    # Stage 3 (Integration): only reachable when Stage 2 clears the dose.
    def build_compounding_label(self, record):
        now = datetime.now(timezone.utc)
        return (
            f'CLEANROOM-LABEL|{record["subject_id"]}|SPECIES:{record["species"]}|DRUG:{record["drug_name"]}|'
            f'DOSE_MG:{record["requested_dosage_mg"]}|WEIGHT_G:{record["weight_grams"]}|VERIFIED:TRUE|'
            f'LABEL_ID:CL-{record["subject_id"][:10]}-{int(now.timestamp() * 1000)}'
        )

    # Stage 4a (Micro-Dosing Intercept): only reachable on a validation
    # breach — the compounding label is never generated on this path.
    def build_micro_dosing_intercept(self, record, validation_result):
        return {
            "channel": "pharmacist_micro_dosing_intercept",
            "priority": "active_warning",
            "subject_id": record["subject_id"],
            "drug_name": record["drug_name"],
            "headline": "Micro-dosing intercept: catastrophic overdose risk in sub-1000g patient",
            "reason": validation_result["reason"],
            "requested_action": "Do not compound or dispense as ordered. Recalculate dose against a verified exotic-species formulary before proceeding.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): tokenized Splunk log — the drug name is
    # masked before it ever reaches the log.
    def build_splunk_event(self, record, validation_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "avian-exotic-dosage-guard",
            "source": "hub4_veterinary_operations/avian_exotic_dosage_guard",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "drug_name": mask_value(record["drug_name"]),
                "is_micro_patient": validation_result["is_micro_patient"],
                "breach": validation_result["breach"],
                "requested_micrograms_per_gram": validation_result["requested_micrograms_per_gram"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_request, patient_identifiers):
        record = self.ingest(raw_request, patient_identifiers)
        validation_result = self.validate_dosage(record)

        if validation_result["cleared"]:
            compounding_label = self.build_compounding_label(record)
            splunk_event = self.build_splunk_event(record, validation_result, "cleared_for_compounding")
            return {"compounding_label": compounding_label, "intercept": None, "splunk_event": splunk_event}

        intercept = self.build_micro_dosing_intercept(record, validation_result)
        splunk_event = self.build_splunk_event(record, validation_result, "blocked_micro_dosing_exception")
        return {"compounding_label": None, "intercept": intercept, "splunk_event": splunk_event}
