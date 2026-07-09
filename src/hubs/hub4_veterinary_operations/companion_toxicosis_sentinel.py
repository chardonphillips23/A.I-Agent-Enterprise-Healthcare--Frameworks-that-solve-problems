"""Companion Toxicosis Sentinel (Agent 11, Hub 4)."""

import hashlib
import math
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

SIGNALMENT_ALLOWLIST = ["species", "breed", "age_years", "weight_kg", "ingested_substance", "ingested_grams"]

FIELD_PATTERNS = {
    "owner_name": re.compile(r"owner:\s*([^\n]+)", re.IGNORECASE),
    "pet_name": re.compile(r"pet name:\s*([^\n]+)", re.IGNORECASE),
    "species": re.compile(r"species:\s*([^\n]+)", re.IGNORECASE),
    "breed": re.compile(r"breed:\s*([^\n]+)", re.IGNORECASE),
    "age": re.compile(r"age:\s*(\d+(?:\.\d+)?)", re.IGNORECASE),
    "weight": re.compile(r"weight\s*\(?kg\)?:\s*(\d+(?:\.\d+)?)", re.IGNORECASE),
    "ingested_substance": re.compile(r"ingested substance:\s*([^\n]+)", re.IGNORECASE),
    "ingested_grams": re.compile(r"estimated ingested grams:\s*(\d+(?:\.\d+)?)", re.IGNORECASE),
}

# Simplified, illustrative toxicity model — NOT clinically authoritative.
# toxic_principal_mg_per_gram is the mock mg-of-toxin-per-gram-of-substance
# concentration; lethal_dose_mg_per_kg is the mock mg/kg body weight threshold.
TOXICOSIS_RISK_INDEX = {
    "canine": {
        "chocolate": {"toxic_principal": "theobromine", "toxic_principal_mg_per_gram": 10, "lethal_dose_mg_per_kg": 60},
        "xylitol": {"toxic_principal": "xylitol", "toxic_principal_mg_per_gram": 1000, "lethal_dose_mg_per_kg": 100},
        "grapes": {"toxic_principal": "unidentified nephrotoxin", "toxic_principal_mg_per_gram": 1, "lethal_dose_mg_per_kg": 19},
    },
    "feline": {
        "lilies": {"toxic_principal": "unidentified nephrotoxin", "toxic_principal_mg_per_gram": 1, "lethal_dose_mg_per_kg": 0},
        "acetaminophen": {"toxic_principal": "acetaminophen", "toxic_principal_mg_per_gram": 500, "lethal_dose_mg_per_kg": 50},
    },
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


def extract_field(text, pattern):
    match = pattern.search(text)
    return match.group(1).strip() if match else ""


class CompanionToxicosisSentinel:
    # Stage 1 (Emergency Ingestion): owner name and pet name are only used
    # here to derive a hashed subject_id; only signalment and ingestion
    # details survive into the record.
    def ingest(self, raw_text):
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise TypeError("raw_text must be a non-empty string")
        owner_name = extract_field(raw_text, FIELD_PATTERNS["owner_name"])
        pet_name = extract_field(raw_text, FIELD_PATTERNS["pet_name"])
        if not owner_name or not pet_name:
            raise ValueError("raw_text requires Owner and Pet Name to derive a subject_id")

        weight_match = FIELD_PATTERNS["weight"].search(raw_text)
        if not weight_match:
            raise ValueError("raw_text requires a Weight (kg) reading")

        age_field = extract_field(raw_text, FIELD_PATTERNS["age"])
        record = {
            "subject_id": hash_subject_id(owner_name, pet_name),
            "species": extract_field(raw_text, FIELD_PATTERNS["species"]) or "unknown",
            "breed": extract_field(raw_text, FIELD_PATTERNS["breed"]) or "unknown",
            "age_years": float(age_field) if age_field else None,
            "weight_kg": float(weight_match.group(1)),
            "ingested_substance": extract_field(raw_text, FIELD_PATTERNS["ingested_substance"]) or "unknown",
            "ingested_grams": float(extract_field(raw_text, FIELD_PATTERNS["ingested_grams"]) or 0),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in SIGNALMENT_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Toxicosis Risk Screening): defense-in-depth guard, then look
    # up the ingested substance in the species-specific risk index and
    # compute a toxic-dose ratio scaled by the patient's body weight.
    def compute_toxicity(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in SIGNALMENT_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached toxicity screening stage')

        species_lower = record["species"].lower()
        species_key = "feline" if ("cat" in species_lower or "feline" in species_lower) else "canine"
        substance_lower = record["ingested_substance"].lower()
        substance_key = next((key for key in TOXICOSIS_RISK_INDEX[species_key] if key in substance_lower), None)

        if not substance_key:
            return {"recognized": False, "toxic_principal": None, "toxic_ratio": 0, "critical_risk": False}

        entry = TOXICOSIS_RISK_INDEX[species_key][substance_key]
        total_toxic_mg = record["ingested_grams"] * entry["toxic_principal_mg_per_gram"]
        dose_mg_per_kg = total_toxic_mg / record["weight_kg"] if record["weight_kg"] > 0 else math.inf
        if entry["lethal_dose_mg_per_kg"] > 0:
            toxic_ratio = dose_mg_per_kg / entry["lethal_dose_mg_per_kg"]
        else:
            toxic_ratio = math.inf if total_toxic_mg > 0 else 0

        return {
            "recognized": True,
            "substance_key": substance_key,
            "toxic_principal": entry["toxic_principal"],
            "dose_mg_per_kg": dose_mg_per_kg,
            "toxic_ratio": toxic_ratio,
            "critical_risk": toxic_ratio >= 1,
        }

    # Stage 3 (Integration): PIMS emergency whiteboard entry — generated on
    # every case, since the whiteboard reflects every patient in triage.
    def build_whiteboard_triage(self, record, tox_result):
        ratio_display = f'{tox_result["toxic_ratio"]:.2f}' if math.isfinite(tox_result["toxic_ratio"]) else "INF"
        lines = [
            f'PIMS-WHITEBOARD|{record["subject_id"]}|SPECIES:{record["species"]}|BREED:{record["breed"]}|AGE:{record["age_years"] if record["age_years"] is not None else "unknown"}y|WEIGHT:{record["weight_kg"]}kg',
            f'INGESTION|SUBSTANCE:{record["ingested_substance"]}|AMOUNT_G:{record["ingested_grams"]}|TOXIC_PRINCIPAL:{tox_result["toxic_principal"] or "unrecognized"}',
            f'RISK|RATIO:{ratio_display}|STATUS:{"STAT" if tox_result["critical_risk"] else "MONITOR"}',
        ]
        return "\n".join(lines)

    # Stage 4a (Clinical Sentinel Intercept): only built when the toxic
    # ratio reaches or exceeds the lethal-dose-equivalent threshold.
    def build_decontamination_alert(self, record, tox_result):
        return {
            "channel": "stat_decontamination_team",
            "priority": "stat",
            "subject_id": record["subject_id"],
            "headline": f'STAT: toxic ingestion ratio {tox_result["toxic_ratio"]:.2f}x lethal-dose-equivalent for {record["ingested_substance"]}',
            "detail": f'{record["species"]} ({record["breed"]}), {record["weight_kg"]}kg ingested ~{record["ingested_grams"]}g of {record["ingested_substance"]} ({tox_result["toxic_principal"]}).',
            "requested_action": "Initiate emesis induction/activated charcoal protocol immediately per toxicology guidance; prepare IV fluids and continuous monitoring.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): masked Splunk event on every case.
    def build_splunk_event(self, record, tox_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "companion-toxicosis-sentinel",
            "source": "hub4_veterinary_operations/companion_toxicosis_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "critical_risk": tox_result["critical_risk"],
                "toxic_ratio": tox_result["toxic_ratio"],
                "masked_substance": mask_value(record["ingested_substance"]),
                "species": record["species"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_text):
        record = self.ingest(raw_text)
        tox_result = self.compute_toxicity(record)
        whiteboard_payload = self.build_whiteboard_triage(record, tox_result)
        decontamination_alert = self.build_decontamination_alert(record, tox_result) if tox_result["critical_risk"] else None
        splunk_event = self.build_splunk_event(
            record, tox_result, "stat_decontamination_triggered" if decontamination_alert else "routine_monitoring"
        )
        return {
            "whiteboard_payload": whiteboard_payload,
            "decontamination_alert": decontamination_alert,
            "splunk_event": splunk_event,
            "toxic_ratio": tox_result["toxic_ratio"],
            "critical_risk": tox_result["critical_risk"],
        }
