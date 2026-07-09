"""Compounding Allergy Auditor (Agent 10, Hub 3)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

COMPOUND_ALLOWLIST = ["components", "allergy_profile"]

CROSS_REACTIVITY_MAP = {
    "penicillin": {"allergy_keywords": ["penicillin", "penicillins", "amoxicillin", "ampicillin"], "reaction_risk": "anaphylaxis"},
    "cephalosporin": {"allergy_keywords": ["cephalosporin", "cephalosporins", "cefazolin"], "reaction_risk": "anaphylaxis_cross_reactivity"},
    "sulfa": {"allergy_keywords": ["sulfa", "sulfonamide", "sulfonamides"], "reaction_risk": "anaphylaxis"},
}

_COMPONENT_NAME_PATTERN = re.compile(r"^([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)*)")


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize(s):
    s = re.sub(r"[^a-z]", "", str(s).lower())
    return re.sub(r"s$", "", s)


def extract_component_name(segment):
    trimmed = segment.strip()
    match = _COMPONENT_NAME_PATTERN.match(trimmed)
    return match.group(1).strip() if match else trimmed


class CompoundingAllergyAuditor:
    # Stage 1 (Formula Ingestion): split the compounding order into its
    # chemical component names and pair them with the patient's allergy
    # profile; the raw formula string is discarded after extraction.
    def ingest(self, formula_text, allergy_profile, patient_identifiers):
        if not isinstance(formula_text, str) or not formula_text.strip():
            raise TypeError("formula_text must be a non-empty string")
        if not isinstance(allergy_profile, list):
            raise TypeError("allergy_profile must be a list")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")

        components = [c for c in (extract_component_name(seg) for seg in formula_text.split("+")) if c]

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "components": components,
            "allergy_profile": [str(a) for a in allergy_profile],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in COMPOUND_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Cross-Reactivity Rules): defense-in-depth guard,
    # then normalize component and allergy names (handling plural mismatches
    # like "Penicillin" vs. "Penicillins") to find any cross-reactivity.
    def audit_cross_reactivity(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in COMPOUND_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached audit stage')

        conflicts = []
        for component in record["components"]:
            component_norm = normalize(component)
            map_entry = next(((key, info) for key, info in CROSS_REACTIVITY_MAP.items() if key in component_norm), None)
            if not map_entry:
                continue

            _, info = map_entry
            for allergy in record["allergy_profile"]:
                allergy_norm = normalize(allergy)
                is_match = any(normalize(keyword) == allergy_norm for keyword in info["allergy_keywords"])
                if is_match:
                    conflicts.append({"component": component, "allergy": allergy, "reaction_risk": info["reaction_risk"]})

        return {"conflicts": conflicts, "cleared": len(conflicts) == 0}

    # Stage 3 (Integration): only reachable when Stage 2 clears the order.
    # Shapes a cleanroom compound verification record.
    def build_cleanroom_verification(self, record):
        now = datetime.now(timezone.utc)
        return {
            "verification_type": "CleanroomCompoundVerification",
            "status": "verified",
            "subject_id": record["subject_id"],
            "components": record["components"],
            "allergy_profile_checked": record["allergy_profile"],
            "verification_id": f'CRV-{record["subject_id"][:10]}-{int(now.timestamp() * 1000)}',
            "verified_at": iso_now(),
        }

    # Stage 4a (Cleanroom Intercept): only reachable on a cross-reactivity
    # conflict — the verification payload is never generated on this path.
    def build_cleanroom_intercept(self, record, audit_result):
        return {
            "channel": "cleanroom_lab_tech_intercept",
            "priority": "hard_block",
            "subject_id": record["subject_id"],
            "headline": "STOP: anaphylactic cross-reactivity risk detected in compounding order",
            "conflicts": [
                f'Component "{c["component"]}" conflicts with documented allergy "{c["allergy"]}" — risk: {c["reaction_risk"]}.'
                for c in audit_result["conflicts"]
            ],
            "requested_action": "Do not compound as ordered. Contact the prescriber to select a non-cross-reactive alternative before proceeding.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): fully masked Splunk audit log — component
    # and allergy names are masked before they ever reach the log.
    def build_splunk_event(self, record, audit_result, outcome):
        masked_conflicts = [
            {"component": mask_value(c["component"]), "allergy": mask_value(c["allergy"]), "reaction_risk": c["reaction_risk"]}
            for c in audit_result["conflicts"]
        ]

        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "compounding-allergy-auditor",
            "source": "hub3_pharmacy_logistics/compounding_allergy_auditor",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "cleared": audit_result["cleared"],
                "conflict_count": len(audit_result["conflicts"]),
                "masked_conflicts": masked_conflicts,
                "processed_at": iso_now(),
            },
        }

    def run(self, formula_text, allergy_profile, patient_identifiers):
        record = self.ingest(formula_text, allergy_profile, patient_identifiers)
        audit_result = self.audit_cross_reactivity(record)

        if audit_result["cleared"]:
            verification = self.build_cleanroom_verification(record)
            splunk_event = self.build_splunk_event(record, audit_result, "cleared_for_compounding")
            return {"verification": verification, "intercept": None, "splunk_event": splunk_event}

        intercept = self.build_cleanroom_intercept(record, audit_result)
        splunk_event = self.build_splunk_event(record, audit_result, "blocked_cross_reactivity")
        return {"verification": None, "intercept": intercept, "splunk_event": splunk_event}
