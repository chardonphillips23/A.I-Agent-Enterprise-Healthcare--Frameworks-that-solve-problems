"""Shelter Intake Quarantine Router (Agent 14, Hub 4)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

INTAKE_ALLOWLIST = ["species", "symptoms"]

DISEASE_MATRIX = {
    "canine_parvovirus": {
        "species_match": ["canine", "dog"],
        "symptom_keywords": ["bloody diarrhea", "vomiting", "lethargy", "parvo"],
        "quarantine_tier": "strict_isolation",
    },
    "feline_leukemia": {
        "species_match": ["feline", "cat"],
        "symptom_keywords": ["feline leukemia", "felv", "weight loss", "chronic infection"],
        "quarantine_tier": "strict_isolation",
    },
    "feline_panleukopenia": {
        "species_match": ["feline", "cat"],
        "symptom_keywords": ["panleukopenia", "severe vomiting", "bloody diarrhea"],
        "quarantine_tier": "strict_isolation",
    },
    "rabies_vector": {
        "species_match": ["canine", "feline", "dog", "cat", "wildlife"],
        "symptom_keywords": ["rabies vector", "unprovoked aggression", "neurological signs", "unknown bite wound"],
        "quarantine_tier": "rabies_observation_hold",
    },
}


def hash_intake_id(stray_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{stray_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ShelterIntakeQuarantineRouter:
    # Stage 1 (Intake Ingestion): the raw stray identifier is only used to
    # derive a hashed intake_id; species and symptom list survive.
    def ingest(self, intake_record):
        if not isinstance(intake_record, dict):
            raise TypeError("intake_record must be a dict")
        stray_id = intake_record.get("stray_id")
        species = intake_record.get("species")
        symptoms = intake_record.get("symptoms")
        if not stray_id:
            raise ValueError("intake_record requires stray_id to derive an intake_id")
        if not species:
            raise ValueError("intake_record requires species")

        record = {
            "intake_id": hash_intake_id(stray_id),
            "species": species,
            "symptoms": [str(s) for s in symptoms] if isinstance(symptoms, list) else [],
        }

        for key in list(record.keys()):
            if key != "intake_id" and key not in INTAKE_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Infectious Disease Screening): defense-in-depth guard, then
    # cross-reference species and symptom keywords against the disease matrix.
    def evaluate_quarantine_risk(self, record):
        leaked = next((k for k in record if k != "intake_id" and k not in INTAKE_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached screening stage')

        species_lower = record["species"].lower()
        symptoms_lower = [s.lower() for s in record["symptoms"]]
        matches = []

        for disease_key, info in DISEASE_MATRIX.items():
            species_ok = any(s in species_lower for s in info["species_match"])
            if not species_ok:
                continue
            symptom_match = any(keyword in sym for keyword in info["symptom_keywords"] for sym in symptoms_lower)
            if symptom_match:
                matches.append({"disease_key": disease_key, "quarantine_tier": info["quarantine_tier"]})

        high_risk = len(matches) > 0
        return {"matches": matches, "high_risk": high_risk, "quarantine_tier": matches[0]["quarantine_tier"] if high_risk else "general_population_eligible"}

    # Stage 3a (Integration): housing assignment — always generated, since
    # every intake gets assigned somewhere.
    def build_housing_assignment(self, record, risk_result):
        return {
            "ticket_type": "housing_assignment",
            "intake_id": record["intake_id"],
            "species": record["species"],
            "assigned_ward": "ISOLATION_WARD_QUARANTINE" if risk_result["high_risk"] else "GENERAL_POPULATION_WARD",
            "quarantine_tier": risk_result["quarantine_tier"],
            "assigned_at": iso_now(),
        }

    # Stage 3b (Integration): only reachable on a high-risk match.
    def build_biohazard_ticket(self, record, risk_result):
        return {
            "channel": "biohazard_cleaning_queue",
            "priority": "urgent",
            "intake_id": record["intake_id"],
            "detected_diseases": [m["disease_key"] for m in risk_result["matches"]],
            "requested_action": "Perform full biohazard-protocol decontamination of the intake area before processing the next animal.",
            "created_at": iso_now(),
        }

    # Stage 4 (Access Control Guard): reject the request outright if no
    # valid-looking security signature is present.
    def validate_security_signature(self, headers):
        auth_header = (headers or {}).get("authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise ValueError("Access denied: missing or malformed security signature")
        token = auth_header[len("Bearer "):].strip()
        if len(token) < 20:
            raise ValueError("Access denied: security signature failed validation")
        return {"valid": True, "token_fingerprint": hashlib.sha256(token.encode()).hexdigest()[:12]}

    # Stage 4 (Audit Telemetry): masked Splunk audit event on every intake.
    def build_splunk_event(self, record, risk_result, housing_assignment, token_validation):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "shelter-intake-quarantine-router",
            "source": "hub4_veterinary_operations/shelter_intake_quarantine_router",
            "sourcetype": "_json",
            "event": {
                "intake_id": record["intake_id"],
                "action": "quarantine_isolation_assigned" if risk_result["high_risk"] else "general_population_assigned",
                "high_risk": risk_result["high_risk"],
                "detected_diseases": [m["disease_key"] for m in risk_result["matches"]],
                "assigned_ward": housing_assignment["assigned_ward"],
                "token_fingerprint": token_validation["token_fingerprint"],
                "masked_symptoms": [mask_value(s) for s in record["symptoms"]],
                "processed_at": iso_now(),
            },
        }

    def run(self, intake_record, request_headers):
        record = self.ingest(intake_record)
        risk_result = self.evaluate_quarantine_risk(record)
        housing_assignment = self.build_housing_assignment(record, risk_result)

        if risk_result["high_risk"] and housing_assignment["assigned_ward"] == "GENERAL_POPULATION_WARD":
            raise ValueError("Compliance violation: high-risk intake routed to general population ward")

        biohazard_ticket = self.build_biohazard_ticket(record, risk_result) if risk_result["high_risk"] else None
        token_validation = self.validate_security_signature(request_headers)
        splunk_event = self.build_splunk_event(record, risk_result, housing_assignment, token_validation)
        return {"housing_assignment": housing_assignment, "biohazard_ticket": biohazard_ticket, "splunk_event": splunk_event}
