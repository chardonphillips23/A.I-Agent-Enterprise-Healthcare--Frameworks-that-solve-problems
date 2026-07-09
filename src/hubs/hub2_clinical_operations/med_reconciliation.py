"""Automated Medication Reconciliation & Drug-Interaction Sentinel (Agent 5, Hub 2)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

MED_LIST_ALLOWLIST = ["home_medications", "new_orders"]

_FLAGS = re.IGNORECASE | re.DOTALL

SECTION_PATTERNS = {
    "home_medications": re.compile(r"home medications:\s*(.*?)(?=\n\s*(?:new orders|hospital medications):|$)", _FLAGS),
    "new_orders": re.compile(r"(?:new orders|hospital medications):\s*(.*?)(?=\n\s*(?:home medications):|$)", _FLAGS),
}

CLINICAL_RISK_DICTIONARY = {
    "warfarin": {
        "interacts_with": ["aspirin", "ibuprofen", "naproxen"],
        "risk_category": "bleeding_risk",
        "severity": "critical",
        "mechanism": "Concurrent NSAID/antiplatelet use potentiates anticoagulant effect, elevating GI and intracranial hemorrhage risk.",
        "alternative_suggestion": "Consider acetaminophen for analgesia; if antiplatelet therapy is required, consult cardiology before co-administration.",
    },
    "lisinopril": {
        "interacts_with": ["spironolactone", "potassium chloride"],
        "risk_category": "hyperkalemia_risk",
        "severity": "high",
        "mechanism": "ACE inhibitor combined with a potassium-sparing agent increases risk of dangerous hyperkalemia.",
        "alternative_suggestion": "Monitor serum potassium closely, or consider a non-potassium-sparing alternative.",
    },
    "metformin": {
        "interacts_with": ["iodinated contrast"],
        "risk_category": "lactic_acidosis_risk",
        "severity": "high",
        "mechanism": "Iodinated contrast media can impair renal clearance of metformin, increasing lactic acidosis risk.",
        "alternative_suggestion": "Hold metformin at the time of contrast administration and for 48 hours post-procedure.",
    },
}

_MED_LINE_PATTERN = re.compile(r"^(.+?)\s+(\d+\s?(?:mg|mcg|ml|g|units))\b\s*(.*)$", re.IGNORECASE)


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def extract_field(text, pattern):
    match = pattern.search(text)
    return match.group(1) if match else ""


def extract_list_items(section_text):
    if not section_text:
        return []
    items = []
    for line in section_text.split("\n"):
        cleaned = re.sub(r"^[\s*-]+", "", line).strip()
        if cleaned:
            items.append(cleaned)
    return items


def parse_medication_line(line):
    match = _MED_LINE_PATTERN.match(line)
    if not match:
        return {"name": line.strip(), "dosage": "", "frequency": ""}
    return {"name": match.group(1).strip(), "dosage": match.group(2).strip(), "frequency": match.group(3).strip()}


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


class MedReconciliationSentinel:
    # Stage 1 (Medication List Ingestion): isolate home-medication and
    # new-order lines into structured {name, dosage, frequency} entries.
    # The raw note text is discarded after extraction and never persisted.
    def ingest(self, medication_text, patient_identifiers):
        if not isinstance(medication_text, str) or not medication_text.strip():
            raise TypeError("medication_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")

        home_lines = extract_list_items(extract_field(medication_text, SECTION_PATTERNS["home_medications"]))
        new_order_lines = extract_list_items(extract_field(medication_text, SECTION_PATTERNS["new_orders"]))

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "home_medications": [parse_medication_line(line) for line in home_lines],
            "new_orders": [parse_medication_line(line) for line in new_order_lines],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in MED_LIST_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Clinical Risk & Interaction Screening): defense-in-depth guard
    # re-validates the record against the Stage 1 allowlist before cross-
    # referencing home medications against new orders in the risk dictionary.
    def screen_interactions(self, structured_list):
        leaked = next((k for k in structured_list if k != "subject_id" and k not in MED_LIST_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached screening stage')

        conflicts = []
        for home_med in structured_list["home_medications"]:
            risk_entry = CLINICAL_RISK_DICTIONARY.get(home_med["name"].lower())
            if not risk_entry:
                continue

            for new_order in structured_list["new_orders"]:
                is_interacting = any(drug in new_order["name"].lower() for drug in risk_entry["interacts_with"])
                if is_interacting:
                    conflicts.append({
                        "home_medication": home_med["name"],
                        "new_order": new_order["name"],
                        "risk_category": risk_entry["risk_category"],
                        "severity": risk_entry["severity"],
                        "mechanism": risk_entry["mechanism"],
                        "alternative_suggestion": risk_entry["alternative_suggestion"],
                    })

        return {"conflicts": conflicts, "passed": len(conflicts) == 0}

    # Stage 3 (Automated Order Adjustment Formulator): only reachable when
    # Stage 2 finds zero conflicts. Shapes a FHIR Bundle of MedicationRequest
    # resources unifying home medications and new orders into one record.
    def build_reconciled_fhir_bundle(self, structured_list):
        def to_entry(med, category):
            return {
                "resource": {
                    "resourceType": "MedicationRequest",
                    "status": "active",
                    "intent": "order",
                    "category": [{"text": category}],
                    "subject": {"reference": f'Patient/{structured_list["subject_id"]}'},
                    "medicationCodeableConcept": {"text": med["name"]},
                    "dosageInstruction": [{"text": f'{med["dosage"]} {med["frequency"]}'.strip()}],
                }
            }

        return {
            "resourceType": "Bundle",
            "type": "collection",
            "meta": {"tag": [{"system": "urn:mock:med-reconciliation", "code": "reconciled"}]},
            "timestamp": iso_now(),
            "entry": (
                [to_entry(med, "home-medication") for med in structured_list["home_medications"]]
                + [to_entry(med, "hospital-new-order") for med in structured_list["new_orders"]]
            ),
        }

    # Stage 4a (Clinical Sentinel Intercept): only reachable when Stage 2
    # flags a conflict. Blocks the reconciled payload and builds an urgent,
    # specific alert for the attending physician naming the exact interaction
    # and a suggested alternative.
    def build_clinical_intercept(self, structured_list, screening_result):
        return {
            "channel": "attending_physician_intercept",
            "priority": "critical_stop",
            "subject_id": structured_list["subject_id"],
            "headline": "STOP: high-risk drug interaction detected between home medication and new order",
            "conflicts": [
                f'{c["home_medication"]} (home) + {c["new_order"]} (new order): {c["risk_category"]} [{c["severity"]}] — {c["mechanism"]} Suggested alternative: {c["alternative_suggestion"]}'
                for c in screening_result["conflicts"]
            ],
            "requested_action": "Do not administer the new order as written. Review the conflict(s) above and select an alternative before proceeding.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): Splunk HEC audit event for both outcomes.
    # Drug names are masked before they ever reach the log so the audit
    # trail carries no plaintext clinical identifiers.
    def build_splunk_event(self, screening_result, outcome, structured_list):
        masked_conflicts = [
            {
                "home_medication": mask_value(c["home_medication"]),
                "new_order": mask_value(c["new_order"]),
                "risk_category": c["risk_category"],
                "severity": c["severity"],
            }
            for c in screening_result["conflicts"]
        ]

        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "med-reconciliation-sentinel",
            "source": "hub2_clinical_operations/med_reconciliation",
            "sourcetype": "_json",
            "event": {
                "subject_id": structured_list["subject_id"],
                "action": outcome,
                "passed": screening_result["passed"],
                "conflict_count": len(screening_result["conflicts"]),
                "masked_conflicts": masked_conflicts,
                "processed_at": iso_now(),
            },
        }

    def run(self, medication_text, patient_identifiers):
        structured_list = self.ingest(medication_text, patient_identifiers)
        screening_result = self.screen_interactions(structured_list)

        if screening_result["passed"]:
            fhir_bundle = self.build_reconciled_fhir_bundle(structured_list)
            splunk_event = self.build_splunk_event(screening_result, "reconciled_and_committed", structured_list)
            return {"fhir_bundle": fhir_bundle, "clinical_intercept": None, "splunk_event": splunk_event}

        clinical_intercept = self.build_clinical_intercept(structured_list, screening_result)
        splunk_event = self.build_splunk_event(screening_result, "blocked_critical_interaction", structured_list)
        return {"fhir_bundle": None, "clinical_intercept": clinical_intercept, "splunk_event": splunk_event}
