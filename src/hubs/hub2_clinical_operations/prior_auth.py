"""Automated Electronic Prior Authorization (ePA) Coordinator (Agent 3, Hub 2)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

NOTE_ALLOWLIST = ["requested_procedure", "history_of_treatments", "diagnosis"]

FIELD_PATTERNS = {
    "requested_procedure": re.compile(r"requested procedure:\s*([^\n]+)", re.IGNORECASE),
    "history_of_treatments": re.compile(r"(?:history of treatments|prior treatments|treatment history):\s*([^\n]+)", re.IGNORECASE),
    "diagnosis": re.compile(r"diagnosis:\s*([^\n]+)", re.IGNORECASE),
}

MEDICAL_POLICY_DICTIONARY = {
    "knee_arthroplasty": {
        "policy_id": "POLICY-KNEE-ARTHRO-001",
        "match_keywords": ["knee arthroplasty", "knee replacement"],
        "required_treatment_pattern": re.compile(r"physical therapy", re.IGNORECASE),
        "required_treatment_label": "physical therapy",
        "required_duration_weeks": 6,
    },
    "lumbar_fusion": {
        "policy_id": "POLICY-LUMBAR-FUSION-002",
        "match_keywords": ["lumbar fusion", "spinal fusion"],
        "required_treatment_pattern": re.compile(r"physical therapy|epidural steroid injection", re.IGNORECASE),
        "required_treatment_label": "physical therapy or epidural steroid injection",
        "required_duration_weeks": 12,
    },
}


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def extract_field(note_text, pattern):
    match = pattern.search(note_text)
    return match.group(1).strip() if match else ""


class PriorAuthCoordinator:
    # Stage 1 (Scribe Ingestion): pull only the three allowlisted clinical
    # concepts out of the free-text note; the raw note itself is discarded
    # after extraction and never persisted downstream.
    def ingest(self, note_text, patient_identifiers):
        if not isinstance(note_text, str) or not note_text.strip():
            raise TypeError("note_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "requested_procedure": extract_field(note_text, FIELD_PATTERNS["requested_procedure"]),
            "history_of_treatments": extract_field(note_text, FIELD_PATTERNS["history_of_treatments"]),
            "diagnosis": extract_field(note_text, FIELD_PATTERNS["diagnosis"]),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in NOTE_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Medical Policy Matching): match the requested procedure to a
    # mock payer policy, then verify the documented treatment history
    # satisfies that policy's conservative-treatment and duration rules.
    def match_policy(self, structured_note):
        procedure_lower = structured_note["requested_procedure"].lower()
        policy_entry = next(
            (policy for policy in MEDICAL_POLICY_DICTIONARY.values() if any(kw in procedure_lower for kw in policy["match_keywords"])),
            None,
        )

        if not policy_entry:
            return {
                "policy_id": None,
                "passed": False,
                "missing_criteria": [
                    f'No medical policy on file matches requested procedure "{structured_note["requested_procedure"]}" — route to manual clinical review.'
                ],
            }

        missing_criteria = []
        history = structured_note["history_of_treatments"]

        if not policy_entry["required_treatment_pattern"].search(history):
            missing_criteria.append(f'Documentation does not mention required conservative treatment: {policy_entry["required_treatment_label"]}.')
        else:
            duration_match = re.search(r"(\d+)\s*week", history, re.IGNORECASE)
            found_weeks = int(duration_match.group(1)) if duration_match else None
            if found_weeks is None:
                missing_criteria.append(
                    f'{policy_entry["required_treatment_label"]} duration not documented; policy requires at least {policy_entry["required_duration_weeks"]} weeks.'
                )
            elif found_weeks < policy_entry["required_duration_weeks"]:
                missing_criteria.append(
                    f'Documented {policy_entry["required_treatment_label"]} duration ({found_weeks} weeks) is below the required minimum of {policy_entry["required_duration_weeks"]} weeks.'
                )

        if not structured_note["diagnosis"]:
            missing_criteria.append("Diagnosis field is missing from the clinical note.")

        return {
            "policy_id": policy_entry["policy_id"],
            "passed": len(missing_criteria) == 0,
            "missing_criteria": missing_criteria,
        }

    # Stage 3 (API Formulator): only reachable when Stage 2 passes. Shapes a
    # FHIR-style Claim resource with use = "preauthorization", the pattern
    # the Da Vinci PAS implementation guide uses in place of a dedicated
    # "PriorAuthorization" resource type (FHIR has no such resource).
    def build_fhir_payload(self, structured_note, compliance_result):
        return {
            "resourceType": "Claim",
            "meta": {"profile": ["urn:mock:us-davinci-pas-claim"]},
            "status": "active",
            "type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/claim-type", "code": "professional"}]},
            "use": "preauthorization",
            "patient": {"reference": f'Patient/{structured_note["subject_id"]}'},
            "created": iso_now(),
            "priority": {"coding": [{"code": "normal"}]},
            "diagnosis": [{"sequence": 1, "diagnosisCodeableConcept": {"text": structured_note["diagnosis"]}}],
            "item": [{"sequence": 1, "productOrService": {"text": structured_note["requested_procedure"]}}],
            "supportingInfo": [
                {"sequence": 1, "category": {"text": "treatment-history"}, "valueString": structured_note["history_of_treatments"]},
                {"sequence": 2, "category": {"text": "policy-match"}, "valueString": compliance_result["policy_id"]},
            ],
        }

    # Stage 4a (Human-in-the-Loop): only reachable when Stage 2 fails.
    # Builds an action-oriented notification naming the exact documentation
    # gap so a nurse can fix the note without guessing.
    def build_nurse_notification(self, structured_note, compliance_result):
        return {
            "channel": "clinic_nurse_queue",
            "priority": "action_required",
            "subject_id": structured_note["subject_id"],
            "policy_id": compliance_result["policy_id"],
            "headline": f'Prior authorization blocked for "{structured_note["requested_procedure"]}" — documentation incomplete',
            "missing_items": compliance_result["missing_criteria"],
            "requested_action": "Update the clinical note with the missing items above and resubmit for prior authorization review.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Guard): Splunk HEC audit event for both outcomes —
    # approvals and compliance exceptions alike get an audit trail entry.
    def build_splunk_event(self, compliance_result, outcome, structured_note):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "prior-auth-coordinator",
            "source": "hub2_clinical_operations/prior_auth",
            "sourcetype": "_json",
            "event": {
                "subject_id": structured_note["subject_id"],
                "policy_id": compliance_result["policy_id"],
                "outcome": outcome,
                "passed": compliance_result["passed"],
                "missing_criteria": compliance_result["missing_criteria"],
                "requested_procedure": structured_note["requested_procedure"],
                "processed_at": iso_now(),
            },
        }

    def run(self, note_text, patient_identifiers):
        structured_note = self.ingest(note_text, patient_identifiers)
        compliance_result = self.match_policy(structured_note)

        if compliance_result["passed"]:
            fhir_payload = self.build_fhir_payload(structured_note, compliance_result)
            splunk_event = self.build_splunk_event(compliance_result, "approved_for_submission", structured_note)
            return {"fhir_payload": fhir_payload, "nurse_notification": None, "splunk_event": splunk_event}

        nurse_notification = self.build_nurse_notification(structured_note, compliance_result)
        splunk_event = self.build_splunk_event(compliance_result, "blocked_pending_documentation", structured_note)
        return {"fhir_payload": None, "nurse_notification": nurse_notification, "splunk_event": splunk_event}
