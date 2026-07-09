"""Insurance Claim Denial & Appeals Engine (Agent 1, Hub 1)."""

import hashlib
import os
from datetime import datetime, timedelta, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

CLAIM_ALLOWLIST = [
    "claim_id",
    "payer",
    "carc_codes",
    "billed_amount",
    "date_of_service_month",
    "denial_date",
    "supplied_docs",
]

CARC_CATEGORY_MAP = {
    "11": "coding_error",
    "16": "missing_information",
    "18": "duplicate_claim",
    "29": "timely_filing",
    "50": "medical_necessity",
    "96": "non_covered_service",
    "97": "bundled_service",
    "197": "missing_authorization",
    "204": "plan_exclusion",
}

CATEGORY_APPEAL_PROFILE = {
    "coding_error": {"appealable": True, "deadline_days": 90, "required_docs": ["corrected_claim", "coding_rationale"]},
    "missing_information": {"appealable": True, "deadline_days": 90, "required_docs": ["missing_field_correction"]},
    "duplicate_claim": {"appealable": False, "deadline_days": 0, "required_docs": []},
    "timely_filing": {"appealable": True, "deadline_days": 30, "required_docs": ["proof_of_timely_submission"]},
    "medical_necessity": {"appealable": True, "deadline_days": 180, "required_docs": ["clinical_notes", "physician_letter", "medical_literature"]},
    "non_covered_service": {"appealable": False, "deadline_days": 0, "required_docs": []},
    "bundled_service": {"appealable": True, "deadline_days": 90, "required_docs": ["ncci_edit_rationale", "modifier_justification"]},
    "missing_authorization": {"appealable": True, "deadline_days": 60, "required_docs": ["retro_auth_request", "clinical_notes"]},
    "plan_exclusion": {"appealable": False, "deadline_days": 0, "required_docs": []},
    "unclassified": {"appealable": True, "deadline_days": 90, "required_docs": ["manual_review"]},
}


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ClaimsDenialAppealsEngine:
    # Stage 1: strip direct identifiers, retain only allowlisted claim/billing
    # fields plus a one-way pseudonymous subject ID for downstream correlation.
    def redact(self, raw_denial):
        if not isinstance(raw_denial, dict):
            raise TypeError("raw_denial must be a dict")

        mrn = raw_denial.get("mrn")
        dob = raw_denial.get("dob")
        claim_id = raw_denial.get("claim_id")
        payer = raw_denial.get("payer")
        carc_codes = raw_denial.get("carc_codes")
        billed_amount = raw_denial.get("billed_amount")
        date_of_service = raw_denial.get("date_of_service")
        denial_date = raw_denial.get("denial_date")
        supplied_docs = raw_denial.get("supplied_docs")

        if not mrn or not dob or not claim_id or not payer or not isinstance(carc_codes, list) or len(carc_codes) == 0:
            raise ValueError("raw_denial requires mrn, dob, claim_id, payer, and non-empty carc_codes")

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "claim_id": claim_id,
            "payer": payer,
            "carc_codes": [str(c) for c in carc_codes],
            "billed_amount": float(billed_amount) if billed_amount else 0,
            "date_of_service_month": date_of_service[:7] if date_of_service else None,
            "denial_date": datetime.fromisoformat(denial_date).replace(tzinfo=timezone.utc) if denial_date else datetime.now(timezone.utc),
            "supplied_docs": supplied_docs if isinstance(supplied_docs, list) else [],
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in CLAIM_ALLOWLIST:
                del record[key]
        return record

    # Stage 2: CARC-driven denial classification and appeal-priority score,
    # with a defense-in-depth check that no un-allowlisted field leaked through.
    def score(self, redacted_record):
        leaked = next((k for k in redacted_record if k != "subject_id" and k not in CLAIM_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached scoring stage')

        categories = [CARC_CATEGORY_MAP.get(code, "unclassified") for code in redacted_record["carc_codes"]]
        primary_category = categories[0]
        profile = CATEGORY_APPEAL_PROFILE[primary_category]

        appeal_deadline = redacted_record["denial_date"] + timedelta(days=profile["deadline_days"])
        days_remaining = (appeal_deadline - datetime.now(timezone.utc)).days

        missing_docs = [doc for doc in profile["required_docs"] if doc not in redacted_record["supplied_docs"]]

        priority_score = 0
        if profile["appealable"]:
            priority_score += min(redacted_record["billed_amount"] / 100, 50)
            if days_remaining <= 14:
                priority_score += 30
            elif days_remaining <= 30:
                priority_score += 15
            priority_score += 20 if len(missing_docs) == 0 else 0

        if not profile["appealable"]:
            priority_tier = "none"
        elif priority_score >= 60:
            priority_tier = "high"
        elif priority_score >= 30:
            priority_tier = "medium"
        else:
            priority_tier = "low"

        return {
            **redacted_record,
            "primary_category": primary_category,
            "appealable": profile["appealable"],
            "required_docs": profile["required_docs"],
            "missing_docs": missing_docs,
            "appeal_deadline": appeal_deadline,
            "priority_score": priority_score,
            "priority_tier": priority_tier,
        }

    # Stage 3: shape a UiPath Orchestrator queue-item payload for the
    # appeal-filing/resubmission RPA robot to pick up and execute.
    def build_rpa_payload(self, scored_record):
        priority_map = {"high": "High", "medium": "Normal", "low": "Low", "none": "Low"}
        now = datetime.now(timezone.utc)
        if not scored_record["appealable"]:
            action = "write_off"
        elif len(scored_record["missing_docs"]) == 0:
            action = "submit_appeal"
        else:
            action = "gather_documentation"

        return {
            "queue_name": "CLAIMS_APPEAL_RPA_QUEUE",
            "priority": priority_map[scored_record["priority_tier"]],
            "reference": f'{scored_record["subject_id"]}-{scored_record["claim_id"]}-{int(now.timestamp() * 1000)}',
            "due_date": iso(scored_record["appeal_deadline"]) if scored_record["appealable"] else None,
            "specific_content": {
                "subject_id": scored_record["subject_id"],
                "claim_id": scored_record["claim_id"],
                "payer": scored_record["payer"],
                "action": action,
                "denial_category": scored_record["primary_category"],
                "missing_docs": scored_record["missing_docs"],
                "priority_tier": scored_record["priority_tier"],
                "requested_at": iso(now),
            },
        }

    # Stage 4: format a Splunk HTTP Event Collector (HEC) event for the
    # audit trail — pseudonymous ID and outcome metadata only, no PHI.
    def build_splunk_event(self, rpa_payload):
        content = rpa_payload["specific_content"]
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "claims-denial-appeals-engine",
            "source": "hub1_revenue_cycle/claims_denial",
            "sourcetype": "_json",
            "event": {
                "subject_id": content["subject_id"],
                "claim_id": content["claim_id"],
                "action": content["action"],
                "denial_category": content["denial_category"],
                "priority_tier": content["priority_tier"],
                "queue_reference": rpa_payload["reference"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_denial):
        redacted = self.redact(raw_denial)
        scored = self.score(redacted)
        rpa_payload = self.build_rpa_payload(scored)
        splunk_event = self.build_splunk_event(rpa_payload)
        return {"rpa_payload": rpa_payload, "splunk_event": splunk_event}
