"""Radiation Safety Dose Sentinel (Agent 20, Hub 5)."""

import hashlib
import os
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

DOSE_ALLOWLIST = ["modality", "body_part_examined", "estimated_dlp_mgy_cm", "estimated_dose_msv", "prior_cumulative_msv", "projected_cumulative_msv"]

SAFETY_THRESHOLD_MSV = 50

# Mock DLP (Dose Length Product) -> effective dose conversion factors
# (mSv per mGy·cm), simplified per body region.
CONVERSION_FACTORS = {
    "head": 0.0023,
    "chest": 0.014,
    "abdomen": 0.015,
    "default": 0.015,
}

# Mock cumulative radiation exposure tracking database, keyed by the
# patient's raw MRN — this lookup can only happen in Stage 1, since that's
# the only stage still holding the raw identifier.
MOCK_RADIATION_TRACKING_DATABASE = {
    "MRN-551122": {"prior_cumulative_msv": 42},
    "MRN-551123": {"prior_cumulative_msv": 10},
}


def hash_subject_id(mrn, dob):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{mrn}:{dob}".encode()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RadiationSafetyDoseSentinel:
    # Stage 1 (Order Ingestion): look up the mock cumulative-exposure record
    # while the raw MRN is still available, then carry forward only the
    # derived dose fields plus a hashed subject_id.
    def ingest(self, radiology_order, patient_identifiers):
        patient_identifiers = patient_identifiers or {}
        mrn = patient_identifiers.get("mrn")
        dob = patient_identifiers.get("dob")
        if not mrn or not dob:
            raise ValueError("patient_identifiers requires mrn and dob to derive a subject_id")
        radiology_order = radiology_order or {}
        modality = radiology_order.get("modality")
        body_part_examined = radiology_order.get("body_part_examined")
        estimated_dlp_mgy_cm = radiology_order.get("estimated_dlp_mgy_cm")
        if not modality or not body_part_examined or estimated_dlp_mgy_cm is None:
            raise ValueError("radiology_order requires modality, body_part_examined, and estimated_dlp_mgy_cm")

        tracking_record = MOCK_RADIATION_TRACKING_DATABASE.get(mrn, {"prior_cumulative_msv": 0})
        conversion_factor = CONVERSION_FACTORS.get(body_part_examined.lower(), CONVERSION_FACTORS["default"])
        estimated_dose_msv = float(estimated_dlp_mgy_cm) * conversion_factor
        projected_cumulative_msv = tracking_record["prior_cumulative_msv"] + estimated_dose_msv

        record = {
            "subject_id": hash_subject_id(mrn, dob),
            "modality": modality,
            "body_part_examined": body_part_examined,
            "estimated_dlp_mgy_cm": float(estimated_dlp_mgy_cm),
            "estimated_dose_msv": estimated_dose_msv,
            "prior_cumulative_msv": tracking_record["prior_cumulative_msv"],
            "projected_cumulative_msv": projected_cumulative_msv,
        }

        for key in list(record.keys()):
            if key != "subject_id" and key not in DOSE_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Exposure Risk Screening): defense-in-depth
    # guard, then flag an overexposure risk if the projected lifetime
    # cumulative dose would reach or exceed the strict safety threshold.
    def evaluate_exposure_risk(self, record):
        leaked = next((k for k in record if k != "subject_id" and k not in DOSE_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached risk screening stage')

        overexposure_risk = record["projected_cumulative_msv"] >= SAFETY_THRESHOLD_MSV
        return {"overexposure_risk": overexposure_risk, "margin_msv": SAFETY_THRESHOLD_MSV - record["projected_cumulative_msv"]}

    # Stage 3 (Integration): only reachable when the projected dose would
    # breach the safety threshold. A soft-block — the scan can still
    # proceed, but only with an active radiologist signature justifying it.
    def build_soft_block_warning(self, record, risk_result):
        return {
            "alert_type": "radiation_safety_soft_block",
            "subject_id": record["subject_id"],
            "headline": f'Cumulative radiation exposure would reach {record["projected_cumulative_msv"]:.1f} mSv, exceeding the {SAFETY_THRESHOLD_MSV} mSv lifetime safety threshold',
            "detail": f'Prior cumulative dose {record["prior_cumulative_msv"]:.1f} mSv + estimated new dose {record["estimated_dose_msv"]:.1f} mSv ({record["modality"]} {record["body_part_examined"]}, DLP {record["estimated_dlp_mgy_cm"]} mGy·cm).',
            "requested_action": "This order requires an active radiologist signature justifying medical necessity before the scan may proceed.",
            "signature_required": True,
            "margin_msv": risk_result["margin_msv"],
            "created_at": iso_now(),
        }

    # Stage 4 (Audit Telemetry): secure Splunk HEC compliance record
    # carrying the anonymized tracking fingerprint (the hashed subject_id).
    def build_splunk_event(self, record, risk_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "radiation-safety-dose-sentinel",
            "source": "hub5_imaging_pathology/radiation_safety_dose_sentinel",
            "sourcetype": "_json",
            "event": {
                "subject_id": record["subject_id"],
                "action": outcome,
                "overexposure_risk": risk_result["overexposure_risk"],
                "estimated_dose_msv": record["estimated_dose_msv"],
                "projected_cumulative_msv": record["projected_cumulative_msv"],
                "modality": record["modality"],
                "processed_at": iso_now(),
            },
        }

    def run(self, radiology_order, patient_identifiers):
        record = self.ingest(radiology_order, patient_identifiers)
        risk_result = self.evaluate_exposure_risk(record)
        soft_block_warning = self.build_soft_block_warning(record, risk_result) if risk_result["overexposure_risk"] else None
        splunk_event = self.build_splunk_event(
            record, risk_result, "soft_block_signature_required" if soft_block_warning else "cleared_within_safety_threshold"
        )
        return {
            "soft_block_warning": soft_block_warning,
            "overexposure_risk": risk_result["overexposure_risk"],
            "projected_cumulative_msv": record["projected_cumulative_msv"],
            "splunk_event": splunk_event,
        }
