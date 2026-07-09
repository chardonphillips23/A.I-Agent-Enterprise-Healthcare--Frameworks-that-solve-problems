"""Local execution test runner for all 30 EHAAF agents."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hubs.hub1_revenue_cycle.claims_denial import ClaimsDenialAppealsEngine
from hubs.hub2_clinical_operations.predictor import EdBedCapacityPredictor
from hubs.hub2_clinical_operations.prior_auth import PriorAuthCoordinator
from hubs.hub2_clinical_operations.discharge_orchestrator import DischargeOrchestrator
from hubs.hub2_clinical_operations.med_reconciliation import MedReconciliationSentinel
from hubs.hub2_clinical_operations.icu_acuity_sentinel import IcuAcuitySentinel
from hubs.hub2_clinical_operations.telehealth_triage_router import TelehealthTriageRouter
from hubs.hub3_pharmacy_logistics.substance_compliance_guard import SubstanceComplianceGuard
from hubs.hub3_pharmacy_logistics.cold_chain_iot_sentinel import ColdChainIotSentinel
from hubs.hub3_pharmacy_logistics.compounding_allergy_auditor import CompoundingAllergyAuditor
from hubs.hub4_veterinary_operations.companion_toxicosis_sentinel import CompanionToxicosisSentinel
from hubs.hub4_veterinary_operations.equine_telemetry_mews import EquineTelemetryMews
from hubs.hub4_veterinary_operations.avian_exotic_dosage_guard import AvianExoticDosageGuard
from hubs.hub4_veterinary_operations.shelter_intake_quarantine_router import ShelterIntakeQuarantineRouter
from hubs.hub4_veterinary_operations.livestock_biosecurity_anomaly_detector import LivestockBiosecurityAnomalyDetector
from hubs.hub5_imaging_pathology.dicom_stroke_triage import DicomStrokeTriage
from hubs.hub5_imaging_pathology.critical_biopsy_sentinel import CriticalBiopsySentinel
from hubs.hub5_imaging_pathology.radiology_peer_review_auditor import RadiologyPeerReviewAuditor
from hubs.hub5_imaging_pathology.specimen_mismatch_guard import SpecimenMismatchGuard
from hubs.hub5_imaging_pathology.radiation_safety_dose_sentinel import RadiationSafetyDoseSentinel
from hubs.hub6_edge_telemetry.cardiac_arrhythmia_detector import CardiacArrhythmiaDetector
from hubs.hub6_edge_telemetry.diabetic_hypoglycemia_sentinel import DiabeticHypoglycemiaSentinel
from hubs.hub6_edge_telemetry.elderly_fall_iot_router import ElderlyFallIotRouter
from hubs.hub6_edge_telemetry.respiratory_copd_tracker import RespiratoryCopdTracker
from hubs.hub6_edge_telemetry.smart_pillbox_adherence_auditor import SmartPillboxAdherenceAuditor
from hubs.hub7_dental_operations.cdt_claim_scrubber import CdtClaimScrubber
from hubs.hub7_dental_operations.xray_caries_sentinel import XrayCariesSentinel
from hubs.hub7_dental_operations.periodontal_bone_loss_auditor import PeriodontalBoneLossAuditor
from hubs.hub7_dental_operations.teledentistry_triage_router import TeledentistryTriageRouter
from hubs.hub7_dental_operations.nitrous_oxide_safety_sentinel import NitrousOxideSafetySentinel


def print_banner(title):
    rule = "=" * 70
    print(f"\n{rule}\n=== {title}\n{rule}")


def print_result(label, result):
    print(f"\n--- {label} ---")
    print(json.dumps(result, indent=2, default=str))


def run_claims_denial_demo():
    print_banner("RUNNING AGENT 1: CLAIMS DENIAL & APPEALS ENGINE (Hub 1)")
    engine = ClaimsDenialAppealsEngine()
    raw_denial = {
        "mrn": "MRN-778812",
        "dob": "1968-03-14",
        "claim_id": "CLM-90142",
        "payer": "Acme Health Plan",
        "carc_codes": ["16"],  # CARC 16: missing information
        "billed_amount": 5000,
        "date_of_service": "2026-05-20",
        "denial_date": "2026-06-10",
        "supplied_docs": [],
    }

    print_result("Stage 1 Output (Redacted Record)", engine.redact(raw_denial))
    print_result("Full Run Output (RPA Payload + Splunk Audit)", engine.run(raw_denial))


def run_ed_predictor_demo():
    print_banner("RUNNING AGENT 2: ED BED CAPACITY PREDICTOR (Hub 2)")
    engine = EdBedCapacityPredictor()
    raw_encounter = {
        "mrn": "MRN-334521",
        "dob": "1955-11-02",
        "age": 70,
        "triage_acuity": 2,  # critical ESI level
        "chief_complaint_category": "chest_pain",
        "vitals": {"heart_rate": 115, "spo2": 89},  # abnormal vitals
        "comorbidities": ["diabetes"],
        "arrival_time": "2026-07-08T14:32:00Z",
    }

    print_result("Stage 1 Output (Redacted Record)", engine.redact(raw_encounter))
    print_result("Full Run Output (Risk Tier + RPA Payload + Splunk Audit)", engine.run(raw_encounter))


def run_prior_auth_fail_demo():
    print_banner("RUNNING AGENT 3a: PRIOR AUTH COORDINATOR — FAIL PATH (Hub 2)")
    engine = PriorAuthCoordinator()
    note_text = "\n".join([
        "Requested Procedure: Total knee arthroplasty",
        "History of Treatments: Patient reports chronic knee pain, tried NSAIDs with minimal relief.",
        "Diagnosis: Severe osteoarthritis of the right knee",
    ])
    patient_identifiers = {"mrn": "MRN-556230", "dob": "1960-07-19"}

    print_result("Stage 1 Output (Structured Note)", engine.ingest(note_text, patient_identifiers))
    print_result("Full Run Output (expected: blocked, nurse escalation)", engine.run(note_text, patient_identifiers))


def run_prior_auth_pass_demo():
    print_banner("RUNNING AGENT 3b: PRIOR AUTH COORDINATOR — PASS PATH (Hub 2)")
    engine = PriorAuthCoordinator()
    note_text = "\n".join([
        "Requested Procedure: Knee arthroplasty",
        "History of Treatments: Patient has severe osteoarthritis with 8 weeks of failed physical therapy documented.",
        "Diagnosis: Severe osteoarthritis of the knee",
    ])
    patient_identifiers = {"mrn": "MRN-556231", "dob": "1958-02-11"}

    print_result("Stage 1 Output (Structured Note)", engine.ingest(note_text, patient_identifiers))
    print_result("Full Run Output (expected: approved FHIR prior-auth Claim)", engine.run(note_text, patient_identifiers))


def run_discharge_orchestrator_demo():
    print_banner("RUNNING AGENT 4: DISCHARGE & POST-CARE HANDOFF ORCHESTRATOR (Hub 2)")
    engine = DischargeOrchestrator()
    discharge_text = "\n".join([
        "Medications:",
        "- Lisinopril 10mg once daily",
        "- Metformin 500mg twice daily",
        "",
        "Follow-up:",
        "- Primary care in 7 days",
        "- Cardiology in 2 weeks",
        "",
        "Activity Restrictions:",
        "- No heavy lifting over 10 lbs for 4 weeks",
        "- No driving for 1 week",
    ])
    patient_identifiers = {"mrn": "MRN-667744", "dob": "1972-09-30"}
    request_headers = {"authorization": "Bearer mock-oauth2-bearer-token-abcdef123456"}

    print_result("Stage 1 Output (Structured Discharge Record)", engine.parse(discharge_text, patient_identifiers))
    print_result(
        "Full Run Output (Patient Instructions + e-Rx + Scheduling + Splunk Audit)",
        engine.run(discharge_text, patient_identifiers, request_headers),
    )


def run_med_reconciliation_demo():
    print_banner("RUNNING AGENT 5: MED RECONCILIATION & DRUG-INTERACTION SENTINEL (Hub 2)")
    engine = MedReconciliationSentinel()
    medication_text = "\n".join([
        "Home Medications:",
        "- Warfarin 5mg once daily",
        "",
        "New Orders:",
        "- Ibuprofen 400mg every 6 hours",
    ])
    patient_identifiers = {"mrn": "MRN-889901", "dob": "1949-12-05"}

    print_result("Stage 1 Output (Structured Medication Lists)", engine.ingest(medication_text, patient_identifiers))
    print_result(
        "Full Run Output (expected: blocked, clinical sentinel intercept)",
        engine.run(medication_text, patient_identifiers),
    )


def run_icu_acuity_sentinel_demo():
    print_banner("RUNNING AGENT 6: ICU ACUITY SENTINEL (Hub 2)")
    engine = IcuAcuitySentinel()
    raw_vitals = {
        "mrn": "MRN-445566",
        "dob": "1947-08-03",
        "respiration_rate": 32,  # >=30: critical
        "heart_rate": 135,  # >=130: critical
        "systolic_bp": 78,  # 71-80: hypotensive
        "temperature_celsius": 39.2,  # >=38.5: febrile
    }

    print_result("Stage 1 Output (Redacted Vitals Record)", engine.ingest(raw_vitals))
    print_result("Full Run Output (expected: MEWS >= 5, STAT physician page)", engine.run(raw_vitals))


def run_telehealth_triage_router_demo():
    print_banner("RUNNING AGENT 7: TELEHEALTH TRIAGE ROUTER (Hub 2)")
    engine = TelehealthTriageRouter()
    chat_text = "I have been having chest pain and shortness of breath for the last hour, it is getting worse."
    patient_identifiers = {"mrn": "MRN-221199", "dob": "1980-04-22"}
    messaging_metadata = {"message_count": 4, "session_duration_seconds": 180}
    request_headers = {"authorization": "Bearer mock-oauth2-bearer-token-abcdef123456"}

    print_result("Stage 1 Output (Detected Flags Record)", engine.ingest(chat_text, patient_identifiers, messaging_metadata))
    print_result(
        "Full Run Output (expected: critical triage, WebRTC escalation)",
        engine.run(chat_text, patient_identifiers, messaging_metadata, request_headers),
    )


def run_substance_compliance_guard_demo():
    print_banner("RUNNING AGENT 8: SUBSTANCE COMPLIANCE GUARD (Hub 3)")
    engine = SubstanceComplianceGuard()
    # MRN-990211 is seeded in the mock PDMP database with a 30-day Oxycodone
    # supply filled 2026-06-20 — requesting a refill on 2026-07-09 is only
    # ~63% through that supply, well under the 85% DEA/PDMP threshold.
    raw_request = {
        "drug_name": "Oxycodone",
        "dosage": "10mg",
        "days_supply": 30,
        "requested_fill_date": "2026-07-09",
    }
    patient_identifiers = {"mrn": "MRN-990211", "dob": "1975-01-01"}

    print_result("Stage 1 Output (Rx Record + PDMP Lookup)", engine.ingest(raw_request, patient_identifiers))
    print_result("Full Run Output (expected: blocked, DEA audit exception)", engine.run(raw_request, patient_identifiers))


def run_cold_chain_iot_sentinel_demo():
    print_banner("RUNNING AGENT 9: COLD-CHAIN IOT SENTINEL (Hub 3)")
    engine = ColdChainIotSentinel()
    telemetry_text = "\n".join([
        "Unit: FRIDGE-7",
        "Product: Insulin Glargine",
        "Temperature: 9.4C",
        "Timestamp: 2026-07-09T02:15:00Z",
    ])

    print_result("Stage 1 Output (Redacted Telemetry Record)", engine.ingest(telemetry_text))
    print_result(
        "Full Run Output (expected: warming excursion, redistribution + facilities ticket)",
        engine.run(telemetry_text),
    )


def run_compounding_allergy_auditor_demo():
    print_banner("RUNNING AGENT 10: COMPOUNDING ALLERGY AUDITOR (Hub 3)")
    engine = CompoundingAllergyAuditor()
    formula_text = "Normal Saline 500mL + Penicillin G 2000000 units + Dextrose 5%"
    allergy_profile = ["Penicillins", "Latex"]
    patient_identifiers = {"mrn": "MRN-334455", "dob": "1990-09-09"}

    print_result(
        "Stage 1 Output (Components + Allergy Profile Record)",
        engine.ingest(formula_text, allergy_profile, patient_identifiers),
    )
    print_result(
        "Full Run Output (expected: hard-blocked, cleanroom intercept)",
        engine.run(formula_text, allergy_profile, patient_identifiers),
    )


def run_companion_toxicosis_sentinel_demo():
    print_banner("RUNNING AGENT 11: COMPANION TOXICOSIS SENTINEL (Hub 4)")
    engine = CompanionToxicosisSentinel()
    raw_text = "\n".join([
        "Owner: Maria Gomez",
        "Pet Name: Buddy",
        "Species: Canine",
        "Breed: Labrador Retriever",
        "Age: 4",
        "Weight (kg): 28",
        "Ingested Substance: Baking Chocolate",
        "Estimated Ingested Grams: 200",
    ])

    print_result("Stage 1 Output (Signalment Record)", engine.ingest(raw_text))
    print_result(
        "Full Run Output (expected: toxic ratio >= 1, STAT decontamination alert)",
        engine.run(raw_text),
    )


def run_equine_telemetry_mews_demo():
    print_banner("RUNNING AGENT 12: EQUINE TELEMETRY MEWS (Hub 4)")
    engine = EquineTelemetryMews()
    raw_telemetry = {
        "horse_id": "HORSE-04521",
        "heart_rate": 68,  # >60bpm: colic/shock indicator
        "respiration_rate": 28,
        "temperature_celsius": 38.9,
        "capillary_refill_time": 3,  # >2s: poor perfusion
    }

    print_result("Stage 1 Output (Redacted Vitals Record)", engine.ingest(raw_telemetry))
    print_result("Full Run Output (expected: EEWS >= 5, field surgeon paged)", engine.run(raw_telemetry))


def run_avian_exotic_dosage_guard_demo():
    print_banner("RUNNING AGENT 13: AVIAN/EXOTIC DOSAGE GUARD (Hub 4)")
    engine = AvianExoticDosageGuard()
    raw_request = {
        "species": "African Grey Parrot",
        "weight_grams": 450,
        "drug_name": "Meloxicam",
        "requested_dosage_mg": 0.5,  # far exceeds the 0.2 mcg/g ceiling at this body weight
    }
    patient_identifiers = {"owner_name": "Diane Carter", "pet_name": "Kiwi"}

    print_result("Stage 1 Output (Rx Record)", engine.ingest(raw_request, patient_identifiers))
    print_result(
        "Full Run Output (expected: blocked, micro-dosing intercept)",
        engine.run(raw_request, patient_identifiers),
    )


def run_shelter_intake_quarantine_router_demo():
    print_banner("RUNNING AGENT 14: SHELTER INTAKE QUARANTINE ROUTER (Hub 4)")
    engine = ShelterIntakeQuarantineRouter()
    intake_record = {
        "stray_id": "STRAY-7788",
        "species": "Canine",
        "symptoms": ["bloody diarrhea", "vomiting", "lethargy"],
    }
    request_headers = {"authorization": "Bearer mock-oauth2-bearer-token-abcdef123456"}

    print_result("Stage 1 Output (Intake Record)", engine.ingest(intake_record))
    print_result(
        "Full Run Output (expected: parvovirus match, isolation ward + biohazard ticket)",
        engine.run(intake_record, request_headers),
    )


def run_livestock_biosecurity_anomaly_detector_demo():
    print_banner("RUNNING AGENT 15: LIVESTOCK BIOSECURITY ANOMALY DETECTOR (Hub 4)")
    engine = LivestockBiosecurityAnomalyDetector()
    raw_metrics = {
        "sector_code": "SECTOR-14",
        "species": "poultry_broiler",
        "flock_count": 50000,
        "previous_day_mortality": 45,
        "current_day_mortality": 210,  # +366%: mortality spike
        "previous_day_water_consumption_liters": 12000,
        "current_day_water_consumption_liters": 7000,  # -42%: sharp water drop
        "feed_consumption_kg": 4800,
    }

    print_result("Stage 1 Output (Production Metrics Record)", engine.ingest(raw_metrics))
    print_result(
        "Full Run Output (expected: outbreak detected, USDA report + logistics hold)",
        engine.run(raw_metrics),
    )


def run_dicom_stroke_triage_demo():
    print_banner("RUNNING AGENT 16: DICOM STROKE TRIAGE (Hub 5)")
    engine = DicomStrokeTriage()
    raw_header_text = "\n".join([
        "Patient Name: Robert Chen",
        "Patient ID: MRN-882211",
        "Patient Birth Date: 1965-03-12",
        "Modality: CT",
        "Body Part Examined: HEAD",
        "Scan Protocol: CT Head Without Contrast - Stroke Protocol",
        "Hemorrhage Confidence Score: 0.91",
    ])

    print_result("Stage 1 Output (Redacted DICOM Record)", engine.ingest(raw_header_text))
    print_result(
        "Full Run Output (expected: CT + confidence >= 0.85, STAT neurology page)",
        engine.run(raw_header_text),
    )


def run_critical_biopsy_sentinel_demo():
    print_banner("RUNNING AGENT 17: CRITICAL BIOPSY SENTINEL (Hub 5)")
    engine = CriticalBiopsySentinel()
    raw_text = "\n".join([
        "MRN: MRN-334211",
        "DOB: 1978-11-05",
        "Accession Number: SP-2026-004471",
        "Specimen Source: Left forearm skin punch biopsy",
        "Findings: Sections reveal an asymmetric proliferation of atypical melanocytes consistent with malignant melanoma, Breslow depth 2.1mm.",
    ])
    request_headers = {"authorization": "Bearer mock-oauth2-bearer-token-abcdef123456"}

    print_result("Stage 1 Output (Pathology Record)", engine.ingest(raw_text))
    print_result(
        "Full Run Output (expected: malignant melanoma match, expedited oncology ServiceRequest)",
        engine.run(raw_text, request_headers),
    )


def run_radiology_peer_review_auditor_demo():
    print_banner("RUNNING AGENT 18: RADIOLOGY PEER REVIEW AUDITOR (Hub 5)")
    engine = RadiologyPeerReviewAuditor()
    human_report_text = "Impression: No acute findings. Lungs are clear bilaterally. No acute cardiopulmonary process."
    ai_tag_text = "AI_CV_TAG: Pulmonary Embolism (confidence 0.93)"
    patient_identifiers = {"mrn": "MRN-778121", "dob": "1982-06-30"}

    print_result("Stage 1 Output (Report Record)", engine.ingest(human_report_text, ai_tag_text, patient_identifiers))
    print_result(
        "Full Run Output (expected: AI/human discrepancy, Senior QA worklist task)",
        engine.run(human_report_text, ai_tag_text, patient_identifiers),
    )


def run_specimen_mismatch_guard_demo():
    print_banner("RUNNING AGENT 19: SPECIMEN MISMATCH GUARD (Hub 5)")
    engine = SpecimenMismatchGuard()
    barcode_data = {"specimen_id": "SPEC-99213", "anatomical_site": "Left Lung", "tissue_code": "LUNG-PARENCHYMA"}
    surgical_booking = {"scheduled_anatomical_site": "Right Lung", "scheduled_procedure": "Right upper lobectomy"}

    print_result("Stage 1 Output (Barcode + Booking Record)", engine.ingest(barcode_data, surgical_booking))
    print_result(
        "Full Run Output (expected: site mismatch, hard-blocked with cleanroom alarm)",
        engine.run(barcode_data, surgical_booking),
    )


def run_radiation_safety_dose_sentinel_demo():
    print_banner("RUNNING AGENT 20: RADIATION SAFETY DOSE SENTINEL (Hub 5)")
    engine = RadiationSafetyDoseSentinel()
    radiology_order = {"modality": "CT", "body_part_examined": "Abdomen", "estimated_dlp_mgy_cm": 600}
    # MRN-551122 is seeded in the mock tracking database with 42 mSv prior
    # cumulative exposure; this scan's ~9 mSv pushes the projected total to
    # 51 mSv, past the 50 mSv safety threshold.
    patient_identifiers = {"mrn": "MRN-551122", "dob": "1970-01-01"}

    print_result("Stage 1 Output (Dose Record + Cumulative Lookup)", engine.ingest(radiology_order, patient_identifiers))
    print_result(
        "Full Run Output (expected: overexposure risk, radiologist signature soft-block)",
        engine.run(radiology_order, patient_identifiers),
    )


def run_cardiac_arrhythmia_detector_demo():
    print_banner("RUNNING AGENT 21: CARDIAC ARRHYTHMIA DETECTOR (Hub 6)")
    engine = CardiacArrhythmiaDetector()
    raw_telemetry = {
        "mrn": "MRN-661122",
        "dob": "1955-05-20",
        "heart_rate": 172,  # >160bpm
        "rhythm_status": "unstable",
    }

    print_result("Stage 1 Output (Redacted Telemetry Record)", engine.ingest(raw_telemetry))
    print_result(
        "Full Run Output (expected: VENTRICULAR_TACHYCARDIA, cardiologist paged)",
        engine.run(raw_telemetry),
    )


def run_diabetic_hypoglycemia_sentinel_demo():
    print_banner("RUNNING AGENT 22: DIABETIC HYPOGLYCEMIA SENTINEL (Hub 6)")
    engine = DiabeticHypoglycemiaSentinel()
    raw_text = "\n".join([
        "MRN: MRN-772233",
        "DOB: 1990-02-14",
        "Caregiver Phone: +1-555-0142",
        "Current Glucose: 52",
        "Drop Velocity: 4.5",
    ])
    patient_identifiers = {"mrn": "MRN-772233", "dob": "1990-02-14"}
    request_headers = {"authorization": "Bearer mock-oauth2-bearer-token-abcdef123456"}

    print_result("Stage 1 Output (CGM Record)", engine.ingest(raw_text, patient_identifiers))
    print_result(
        "Full Run Output (expected: midnight crash risk, caregiver SMS alert)",
        engine.run(raw_text, patient_identifiers, request_headers),
    )


def run_elderly_fall_iot_router_demo():
    print_banner("RUNNING AGENT 23: ELDERLY FALL IOT ROUTER (Hub 6)")
    engine = ElderlyFallIotRouter()
    raw_accelerometer_data = {
        "device_id": "WATCH-88213",
        "g_force_value": 5.1,  # >=4.5G
        "no_motion_duration_seconds": 95,  # >=60s
        "latitude": 37.7749,
        "longitude": -122.4194,
    }

    print_result("Stage 1 Output (Redacted Accelerometer Record)", engine.ingest(raw_accelerometer_data))
    print_result(
        "Full Run Output (expected: ELDERLY_FALL_DETECTED, EMS dispatched)",
        engine.run(raw_accelerometer_data),
    )


def run_respiratory_copd_tracker_demo():
    print_banner("RUNNING AGENT 24: RESPIRATORY COPD TRACKER (Hub 6)")
    engine = RespiratoryCopdTracker()
    # 72 hourly readings, all below the 88% threshold (84-87 range).
    historical_spo2 = [84 + (i % 4) for i in range(72)]
    raw_history = {"mrn": "MRN-990044", "dob": "1948-08-15", "historical_spo2": historical_spo2}

    print_result("Stage 1 Output (Redacted Oximeter History Record)", engine.ingest(raw_history))
    print_result(
        "Full Run Output (expected: CHRONIC_RESPIRATORY_DISTRESS, telehealth booking)",
        engine.run(raw_history),
    )


def run_smart_pillbox_adherence_auditor_demo():
    print_banner("RUNNING AGENT 25: SMART PILLBOX ADHERENCE AUDITOR (Hub 6)")
    engine = SmartPillboxAdherenceAuditor()
    now = datetime.now(timezone.utc)
    raw_pillbox_data = {
        "compartment_label": "COMPARTMENT_3_EVENING_DOSE",
        "open_event_timestamps": [
            (now - timedelta(hours=96)).isoformat(),
            (now - timedelta(hours=74)).isoformat(),
            (now - timedelta(hours=50)).isoformat(),  # most recent open: 50h ago
        ],
    }
    patient_identifiers = {"mrn": "MRN-113355", "dob": "1952-12-01"}

    print_result("Stage 1 Output (Redacted Pillbox Record)", engine.ingest(raw_pillbox_data, patient_identifiers))
    print_result(
        "Full Run Output (expected: CRITICAL_MEDICATION_NON_ADHERENCE, pharmacy outreach)",
        engine.run(raw_pillbox_data, patient_identifiers),
    )


def run_cdt_claim_scrubber_demo():
    print_banner("RUNNING AGENT 26: CDT CLAIM SCRUBBER (Hub 7)")
    engine = CdtClaimScrubber()
    raw_claim = {
        "patient_name": "Alan Brooks",
        "patient_id": "PT-55210",
        "primary_cdt_code": "D4341",  # deep scaling
        "secondary_cdt_code": "D1110",  # standard prophylaxis - conflicting pair
        "quadrant": "UR",
    }

    print_result("Stage 1 Output (Redacted Claim Record)", engine.ingest(raw_claim))
    print_result(
        "Full Run Output (expected: CDT_CODE_CONFLICT, blocked with correction ticket)",
        engine.run(raw_claim),
    )


def run_xray_caries_sentinel_demo():
    print_banner("RUNNING AGENT 27: X-RAY CARIES SENTINEL (Hub 7)")
    engine = XrayCariesSentinel()
    raw_text = "\n".join([
        "Patient Name: Nina Patel",
        "Patient ID: PT-66312",
        "Tooth Number: 30",
        "Caries Confidence Score: 0.92",
    ])

    print_result("Stage 1 Output (Redacted X-Ray Record)", engine.ingest(raw_text))
    print_result(
        "Full Run Output (expected: HIGH_DECAY_DETECTION, patient case presentation)",
        engine.run(raw_text),
    )


def run_periodontal_bone_loss_auditor_demo():
    print_banner("RUNNING AGENT 28: PERIODONTAL BONE LOSS AUDITOR (Hub 7)")
    engine = PeriodontalBoneLossAuditor()
    raw_chart = {
        "requested_procedure": "osseous_surgery",
        "measurements": [
            {"tooth_number": 14, "pocket_depth_millimeters": 3},
            {"tooth_number": 15, "pocket_depth_millimeters": 4},
            {"tooth_number": 16, "pocket_depth_millimeters": 3.5},
        ],
    }
    patient_identifiers = {"mrn": "MRN-DEN-4471", "dob": "1985-03-02"}

    print_result("Stage 1 Output (Redacted Charting Record)", engine.ingest(raw_chart, patient_identifiers))
    print_result(
        "Full Run Output (expected: INSUFFICIENT_BONE_LOSS_EVIDENCE, pre-auth soft-block)",
        engine.run(raw_chart, patient_identifiers),
    )


def run_teledentistry_triage_router_demo():
    print_banner("RUNNING AGENT 29: TELEDENTISTRY TRIAGE ROUTER (Hub 7)")
    engine = TeledentistryTriageRouter()
    message_text = "Hi, it's Saturday night and my face is really swollen on the right side near my jaw, it hurts a lot and is getting worse."
    patient_identifiers = {"mrn": "MRN-DEN-9981", "dob": "1995-07-18"}
    messaging_metadata = {"message_count": 2}

    print_result("Stage 1 Output (Redacted Message Record)", engine.ingest(message_text, patient_identifiers, messaging_metadata))
    print_result(
        "Full Run Output (expected: critical priority, STAT oral surgeon page)",
        engine.run(message_text, patient_identifiers, messaging_metadata),
    )


def run_nitrous_oxide_safety_sentinel_demo():
    print_banner("RUNNING AGENT 30: NITROUS OXIDE SAFETY SENTINEL (Hub 7)")
    engine = NitrousOxideSafetySentinel()
    raw_sensor_data = {
        "sensor_id": "N2O-SENSOR-OR3",
        "ppm_value": 38,  # >25ppm
        "sustained_minutes_above_threshold": 7,  # >5 minutes
    }

    print_result("Stage 1 Output (Redacted Sensor Record)", engine.ingest(raw_sensor_data))
    print_result(
        "Full Run Output (expected: HAZARDOUS_NITROUS_LEAK, manifold shutdown + facilities alarm)",
        engine.run(raw_sensor_data),
    )


def main():
    run_claims_denial_demo()
    run_ed_predictor_demo()
    run_prior_auth_fail_demo()
    run_prior_auth_pass_demo()
    run_discharge_orchestrator_demo()
    run_med_reconciliation_demo()
    run_icu_acuity_sentinel_demo()
    run_telehealth_triage_router_demo()
    run_substance_compliance_guard_demo()
    run_cold_chain_iot_sentinel_demo()
    run_compounding_allergy_auditor_demo()
    run_companion_toxicosis_sentinel_demo()
    run_equine_telemetry_mews_demo()
    run_avian_exotic_dosage_guard_demo()
    run_shelter_intake_quarantine_router_demo()
    run_livestock_biosecurity_anomaly_detector_demo()
    run_dicom_stroke_triage_demo()
    run_critical_biopsy_sentinel_demo()
    run_radiology_peer_review_auditor_demo()
    run_specimen_mismatch_guard_demo()
    run_radiation_safety_dose_sentinel_demo()
    run_cardiac_arrhythmia_detector_demo()
    run_diabetic_hypoglycemia_sentinel_demo()
    run_elderly_fall_iot_router_demo()
    run_respiratory_copd_tracker_demo()
    run_smart_pillbox_adherence_auditor_demo()
    run_cdt_claim_scrubber_demo()
    run_xray_caries_sentinel_demo()
    run_periodontal_bone_loss_auditor_demo()
    run_teledentistry_triage_router_demo()
    run_nitrous_oxide_safety_sentinel_demo()

    print_banner("DEMO SEQUENCE COMPLETE — 31 RUNS ACROSS 30 AGENTS")


if __name__ == "__main__":
    main()
