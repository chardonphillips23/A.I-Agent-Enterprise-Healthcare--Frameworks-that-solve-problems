"""Hospital Discharge & Post-Care Handoff Orchestrator (Agent 4, Hub 2)."""

import hashlib
import os
import re
from datetime import datetime, timedelta, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

DISCHARGE_ALLOWLIST = ["medications", "follow_up_timelines", "activity_restrictions"]

_FLAGS = re.IGNORECASE | re.DOTALL

SECTION_PATTERNS = {
    "medications": re.compile(r"medications:\s*(.*?)(?=\n\s*(?:follow-?up|activity restrictions):|$)", _FLAGS),
    "follow_up_timelines": re.compile(r"follow-?up:\s*(.*?)(?=\n\s*(?:medications|activity restrictions):|$)", _FLAGS),
    "activity_restrictions": re.compile(r"activity restrictions:\s*(.*?)(?=\n\s*(?:medications|follow-?up):|$)", _FLAGS),
}

PHARMACY_OPERATIONAL_DB = {
    "lisinopril": {"stock_status": "in_stock", "open_hour": 8, "close_hour": 20},
    "metformin": {"stock_status": "in_stock", "open_hour": 8, "close_hour": 20},
    "warfarin": {"stock_status": "special_order", "open_hour": 9, "close_hour": 17},
}

_MED_LINE_PATTERN = re.compile(r"^(.+?)\s+(\d+\s?(?:mg|mcg|ml|g|units))\b\s*(.*)$", re.IGNORECASE)


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


def lookup_pharmacy(name):
    return PHARMACY_OPERATIONAL_DB.get(name.lower(), {"stock_status": "unknown", "open_hour": None, "close_hour": None})


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


class DischargeOrchestrator:
    # Stage 1 (Discharge Text Parsing): digest the free-text discharge
    # summary into the three allowlisted blocks. The raw summary text is
    # discarded after extraction and never persisted downstream.
    def parse(self, discharge_text, patient_identifiers):
        if not isinstance(discharge_text, str) or not discharge_text.strip():
            raise TypeError("discharge_text must be a non-empty string")
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")

        medication_lines = extract_list_items(extract_field(discharge_text, SECTION_PATTERNS["medications"]))

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "medications": [parse_medication_line(line) for line in medication_lines],
            "follow_up_timelines": extract_list_items(extract_field(discharge_text, SECTION_PATTERNS["follow_up_timelines"])),
            "activity_restrictions": extract_list_items(extract_field(discharge_text, SECTION_PATTERNS["activity_restrictions"])),
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in DISCHARGE_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Safety & Pharmacy Match): flag any medication missing dosage
    # or frequency, then cross-check each medication against a mock pharmacy
    # operational-hours database to confirm it can actually be fulfilled now.
    def validate_safety(self, structured_discharge, at_hour=None):
        if at_hour is None:
            at_hour = datetime.now().hour
        issues = []

        medications_validated = []
        for med in structured_discharge["medications"]:
            complete = bool(med["dosage"]) and bool(med["frequency"])
            if not complete:
                issues.append(f'Medication "{med["name"]}" is missing {"dosage" if not med["dosage"] else "frequency"} information.')

            pharmacy = lookup_pharmacy(med["name"])
            if pharmacy["stock_status"] == "unknown":
                fulfillable = False
                issues.append(f'Medication "{med["name"]}" is not in the pharmacy operational database; manual verification required.')
            elif pharmacy["stock_status"] != "in_stock":
                fulfillable = False
                issues.append(f'Medication "{med["name"]}" is a special-order item and cannot be guaranteed for immediate fulfillment.')
            else:
                fulfillable = pharmacy["open_hour"] <= at_hour < pharmacy["close_hour"]
                if not fulfillable:
                    issues.append(f'Medication "{med["name"]}" requested outside pharmacy operational hours ({pharmacy["open_hour"]}:00-{pharmacy["close_hour"]}:00).')

            medications_validated.append({**med, "complete": complete, "fulfillable": fulfillable})

        return {
            "medications_validated": medications_validated,
            "all_complete": all(m["complete"] for m in medications_validated),
            "all_fulfillable": all(m["fulfillable"] for m in medications_validated),
            "issues": issues,
        }

    def build_patient_instructions(self, structured_discharge):
        lines = ["YOUR DISCHARGE INSTRUCTIONS", "", "Your Medicines:"]
        for med in structured_discharge["medications"]:
            lines.append(f'- Take {med["name"]}, {med["dosage"] or "ask your nurse for the dose"}, {med["frequency"] or "ask your nurse when"}.')
        lines += ["", "Your Next Appointments:"]
        for item in structured_discharge["follow_up_timelines"]:
            lines.append(f"- {item}")
        lines += ["", "Things To Avoid:"]
        for item in structured_discharge["activity_restrictions"]:
            lines.append(f"- {item}")
        lines += ["", "A nurse will call you in 2 days to check how you feel."]
        return "\n".join(lines)

    def build_e_prescribing_payload(self, structured_discharge):
        payload = []
        for index, med in enumerate(structured_discharge["medications"]):
            payload.append({
                "resourceType": "MedicationRequest",
                "status": "active",
                "intent": "order",
                "subject": {"reference": f'Patient/{structured_discharge["subject_id"]}'},
                "medicationCodeableConcept": {"text": med["name"]},
                "dosageInstruction": [{"text": f'{med["dosage"]} {med["frequency"]}'.strip()}],
                "identifier": [{"value": f'{structured_discharge["subject_id"]}-rx-{index + 1}'}],
            })
        return payload

    def build_scheduling_request(self, structured_discharge):
        window_start = datetime.now(timezone.utc) + timedelta(hours=48)
        window_end = window_start + timedelta(hours=2)
        return {
            "ticket_type": "telehealth_follow_up",
            "subject_id": structured_discharge["subject_id"],
            "visit_type": "telehealth",
            "priority": "standard",
            "requested_window_start": iso(window_start),
            "requested_window_end": iso(window_end),
            "notes": "Automated 48-hour post-discharge safety check-in",
        }

    # Stage 3 (Multi-Channel Dispatcher): bundle the three outbound payload
    # shapes together, carrying forward Stage 2's issues as visible flags
    # rather than silently dropping them.
    def build_dispatch_bundle(self, structured_discharge, safety_report):
        return {
            "patient_instructions": self.build_patient_instructions(structured_discharge),
            "e_prescribing": self.build_e_prescribing_payload(structured_discharge),
            "scheduling_request": self.build_scheduling_request(structured_discharge),
            "safety_flags": safety_report["issues"],
        }

    # Stage 4 (Cryptographic & Access Control Guard): reject the request
    # outright if no valid-looking OAuth2 bearer token is present.
    def validate_access_token(self, headers):
        auth_header = (headers or {}).get("authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise ValueError("Access denied: missing or malformed OAuth2 bearer token")
        token = auth_header[len("Bearer "):].strip()
        if len(token) < 20:
            raise ValueError("Access denied: OAuth2 token failed validation")
        return {"valid": True, "token_fingerprint": hashlib.sha256(token.encode()).hexdigest()[:12]}

    # Stage 4 (Audit Guard): mask clinical fields before they ever reach the
    # Splunk HEC event, so the audit trail carries a fingerprint of what
    # happened without persisting plaintext medication data into log storage.
    def build_splunk_event(self, dispatch_bundle, token_validation, structured_discharge):
        masked_medications = [
            {"name": mask_value(med["name"]), "dosage": mask_value(med["dosage"])}
            for med in structured_discharge["medications"]
        ]

        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "discharge-orchestrator",
            "source": "hub2_clinical_operations/discharge_orchestrator",
            "sourcetype": "_json",
            "event": {
                "subject_id": structured_discharge["subject_id"],
                "action": "DISCHARGE_HANDOFF_DISPATCHED",
                "token_fingerprint": token_validation["token_fingerprint"],
                "masked_medications": masked_medications,
                "safety_flag_count": len(dispatch_bundle["safety_flags"]),
                "follow_up_window_start": dispatch_bundle["scheduling_request"]["requested_window_start"],
                "processed_at": iso_now(),
            },
        }

    def run(self, discharge_text, patient_identifiers, request_headers):
        structured_discharge = self.parse(discharge_text, patient_identifiers)
        safety_report = self.validate_safety(structured_discharge)
        dispatch_bundle = self.build_dispatch_bundle(structured_discharge, safety_report)
        token_validation = self.validate_access_token(request_headers)
        splunk_event = self.build_splunk_event(dispatch_bundle, token_validation, structured_discharge)
        return {"dispatch_bundle": dispatch_bundle, "safety_report": safety_report, "splunk_event": splunk_event}
