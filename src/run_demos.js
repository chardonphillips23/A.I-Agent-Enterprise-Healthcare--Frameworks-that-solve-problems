'use strict';

const { ClaimsDenialAppealsEngine } = require('./hubs/hub1_revenue_cycle/claims_denial');
const { EdBedCapacityPredictor } = require('./hubs/hub2_clinical_operations/predictor');
const { PriorAuthCoordinator } = require('./hubs/hub2_clinical_operations/prior_auth');
const { DischargeOrchestrator } = require('./hubs/hub2_clinical_operations/discharge_orchestrator');
const { MedReconciliationSentinel } = require('./hubs/hub2_clinical_operations/med_reconciliation');
const { IcuAcuitySentinel } = require('./hubs/hub2_clinical_operations/icu_acuity_sentinel');
const { TelehealthTriageRouter } = require('./hubs/hub2_clinical_operations/telehealth_triage_router');
const { SubstanceComplianceGuard } = require('./hubs/hub3_pharmacy_logistics/substance_compliance_guard');
const { ColdChainIotSentinel } = require('./hubs/hub3_pharmacy_logistics/cold_chain_iot_sentinel');
const { CompoundingAllergyAuditor } = require('./hubs/hub3_pharmacy_logistics/compounding_allergy_auditor');
const { CompanionToxicosisSentinel } = require('./hubs/hub4_veterinary_operations/companion_toxicosis_sentinel');
const { EquineTelemetryMews } = require('./hubs/hub4_veterinary_operations/equine_telemetry_mews');
const { AvianExoticDosageGuard } = require('./hubs/hub4_veterinary_operations/avian_exotic_dosage_guard');
const { ShelterIntakeQuarantineRouter } = require('./hubs/hub4_veterinary_operations/shelter_intake_quarantine_router');
const { LivestockBiosecurityAnomalyDetector } = require('./hubs/hub4_veterinary_operations/livestock_biosecurity_anomaly_detector');
const { DicomStrokeTriage } = require('./hubs/hub5_imaging_pathology/dicom_stroke_triage');
const { CriticalBiopsySentinel } = require('./hubs/hub5_imaging_pathology/critical_biopsy_sentinel');
const { RadiologyPeerReviewAuditor } = require('./hubs/hub5_imaging_pathology/radiology_peer_review_auditor');
const { SpecimenMismatchGuard } = require('./hubs/hub5_imaging_pathology/specimen_mismatch_guard');
const { RadiationSafetyDoseSentinel } = require('./hubs/hub5_imaging_pathology/radiation_safety_dose_sentinel');
const { CardiacArrhythmiaDetector } = require('./hubs/hub6_edge_telemetry/cardiac_arrhythmia_detector');
const { DiabeticHypoglycemiaSentinel } = require('./hubs/hub6_edge_telemetry/diabetic_hypoglycemia_sentinel');
const { ElderlyFallIotRouter } = require('./hubs/hub6_edge_telemetry/elderly_fall_iot_router');
const { RespiratoryCopdTracker } = require('./hubs/hub6_edge_telemetry/respiratory_copd_tracker');
const { SmartPillboxAdherenceAuditor } = require('./hubs/hub6_edge_telemetry/smart_pillbox_adherence_auditor');
const { CdtClaimScrubber } = require('./hubs/hub7_dental_operations/cdt_claim_scrubber');
const { XrayCariesSentinel } = require('./hubs/hub7_dental_operations/xray_caries_sentinel');
const { PeriodontalBoneLossAuditor } = require('./hubs/hub7_dental_operations/periodontal_bone_loss_auditor');
const { TeledentistryTriageRouter } = require('./hubs/hub7_dental_operations/teledentistry_triage_router');
const { NitrousOxideSafetySentinel } = require('./hubs/hub7_dental_operations/nitrous_oxide_safety_sentinel');

function printBanner(title) {
  const rule = '='.repeat(70);
  console.log(`\n${rule}\n=== ${title}\n${rule}`);
}

function printResult(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(result, null, 2));
}

function runClaimsDenialDemo() {
  printBanner('RUNNING AGENT 1: CLAIMS DENIAL & APPEALS ENGINE (Hub 1)');
  const engine = new ClaimsDenialAppealsEngine();
  const rawDenial = {
    mrn: 'MRN-778812',
    dob: '1968-03-14',
    claimId: 'CLM-90142',
    payer: 'Acme Health Plan',
    carcCodes: ['16'], // CARC 16: missing information
    billedAmount: 5000,
    dateOfService: '2026-05-20',
    denialDate: '2026-06-10',
    suppliedDocs: [],
  };

  printResult('Stage 1 Output (Redacted Record)', engine.redact(rawDenial));
  printResult('Full Run Output (RPA Payload + Splunk Audit)', engine.run(rawDenial));
}

function runEdPredictorDemo() {
  printBanner('RUNNING AGENT 2: ED BED CAPACITY PREDICTOR (Hub 2)');
  const engine = new EdBedCapacityPredictor();
  const rawEncounter = {
    mrn: 'MRN-334521',
    dob: '1955-11-02',
    age: 70,
    triageAcuity: 2, // critical ESI level
    chiefComplaintCategory: 'chest_pain',
    vitals: { heartRate: 115, spo2: 89 }, // abnormal vitals
    comorbidities: ['diabetes'],
    arrivalTime: '2026-07-08T14:32:00Z',
  };

  printResult('Stage 1 Output (Redacted Record)', engine.redact(rawEncounter));
  printResult('Full Run Output (Risk Tier + RPA Payload + Splunk Audit)', engine.run(rawEncounter));
}

function runPriorAuthFailDemo() {
  printBanner('RUNNING AGENT 3a: PRIOR AUTH COORDINATOR — FAIL PATH (Hub 2)');
  const engine = new PriorAuthCoordinator();
  const noteText = [
    'Requested Procedure: Total knee arthroplasty',
    'History of Treatments: Patient reports chronic knee pain, tried NSAIDs with minimal relief.',
    'Diagnosis: Severe osteoarthritis of the right knee',
  ].join('\n');
  const patientIdentifiers = { mrn: 'MRN-556230', dob: '1960-07-19' };

  printResult('Stage 1 Output (Structured Note)', engine.ingest(noteText, patientIdentifiers));
  printResult(
    'Full Run Output (expected: blocked, nurse escalation)',
    engine.run(noteText, patientIdentifiers)
  );
}

function runPriorAuthPassDemo() {
  printBanner('RUNNING AGENT 3b: PRIOR AUTH COORDINATOR — PASS PATH (Hub 2)');
  const engine = new PriorAuthCoordinator();
  // Same clinical facts as the prompt (severe osteoarthritis, 8 weeks of
  // failed physical therapy, recommending knee arthroplasty) reformatted
  // into the engine's expected labeled-note structure — the Stage 1
  // parser matches on "Requested Procedure:" / "History of Treatments:" /
  // "Diagnosis:" labels, the way a scribe/NLP front-end would tag a note.
  const noteText = [
    'Requested Procedure: Knee arthroplasty',
    'History of Treatments: Patient has severe osteoarthritis with 8 weeks of failed physical therapy documented.',
    'Diagnosis: Severe osteoarthritis of the knee',
  ].join('\n');
  const patientIdentifiers = { mrn: 'MRN-556231', dob: '1958-02-11' };

  printResult('Stage 1 Output (Structured Note)', engine.ingest(noteText, patientIdentifiers));
  printResult(
    'Full Run Output (expected: approved FHIR prior-auth Claim)',
    engine.run(noteText, patientIdentifiers)
  );
}

function runDischargeOrchestratorDemo() {
  printBanner('RUNNING AGENT 4: DISCHARGE & POST-CARE HANDOFF ORCHESTRATOR (Hub 2)');
  const engine = new DischargeOrchestrator();
  const dischargeText = [
    'Medications:',
    '- Lisinopril 10mg once daily',
    '- Metformin 500mg twice daily',
    '',
    'Follow-up:',
    '- Primary care in 7 days',
    '- Cardiology in 2 weeks',
    '',
    'Activity Restrictions:',
    '- No heavy lifting over 10 lbs for 4 weeks',
    '- No driving for 1 week',
  ].join('\n');
  const patientIdentifiers = { mrn: 'MRN-667744', dob: '1972-09-30' };
  const requestHeaders = { authorization: 'Bearer mock-oauth2-bearer-token-abcdef123456' };

  printResult('Stage 1 Output (Structured Discharge Record)', engine.parse(dischargeText, patientIdentifiers));
  printResult(
    'Full Run Output (Patient Instructions + e-Rx + Scheduling + Splunk Audit)',
    engine.run(dischargeText, patientIdentifiers, requestHeaders)
  );
}

function runMedReconciliationDemo() {
  printBanner('RUNNING AGENT 5: MED RECONCILIATION & DRUG-INTERACTION SENTINEL (Hub 2)');
  const engine = new MedReconciliationSentinel();
  const medicationText = [
    'Home Medications:',
    '- Warfarin 5mg once daily',
    '',
    'New Orders:',
    '- Ibuprofen 400mg every 6 hours',
  ].join('\n');
  const patientIdentifiers = { mrn: 'MRN-889901', dob: '1949-12-05' };

  printResult('Stage 1 Output (Structured Medication Lists)', engine.ingest(medicationText, patientIdentifiers));
  printResult(
    'Full Run Output (expected: blocked, clinical sentinel intercept)',
    engine.run(medicationText, patientIdentifiers)
  );
}

function runIcuAcuitySentinelDemo() {
  printBanner('RUNNING AGENT 6: ICU ACUITY SENTINEL (Hub 2)');
  const engine = new IcuAcuitySentinel();
  const rawVitals = {
    mrn: 'MRN-445566',
    dob: '1947-08-03',
    respirationRate: 32, // >=30: critical
    heartRate: 135, // >=130: critical
    systolicBP: 78, // 71-80: hypotensive
    temperatureCelsius: 39.2, // >=38.5: febrile
  };

  printResult('Stage 1 Output (Redacted Vitals Record)', engine.ingest(rawVitals));
  printResult(
    'Full Run Output (expected: MEWS >= 5, STAT physician page)',
    engine.run(rawVitals)
  );
}

function runTelehealthTriageRouterDemo() {
  printBanner('RUNNING AGENT 7: TELEHEALTH TRIAGE ROUTER (Hub 2)');
  const engine = new TelehealthTriageRouter();
  const chatText = 'I have been having chest pain and shortness of breath for the last hour, it is getting worse.';
  const patientIdentifiers = { mrn: 'MRN-221199', dob: '1980-04-22' };
  const messagingMetadata = { messageCount: 4, sessionDurationSeconds: 180 };
  const requestHeaders = { authorization: 'Bearer mock-oauth2-bearer-token-abcdef123456' };

  printResult(
    'Stage 1 Output (Detected Flags Record)',
    engine.ingest(chatText, patientIdentifiers, messagingMetadata)
  );
  printResult(
    'Full Run Output (expected: critical triage, WebRTC escalation)',
    engine.run(chatText, patientIdentifiers, messagingMetadata, requestHeaders)
  );
}

function runSubstanceComplianceGuardDemo() {
  printBanner('RUNNING AGENT 8: SUBSTANCE COMPLIANCE GUARD (Hub 3)');
  const engine = new SubstanceComplianceGuard();
  // MRN-990211 is seeded in the mock PDMP database with a 30-day Oxycodone
  // supply filled 2026-06-20 — requesting a refill on 2026-07-09 is only
  // ~63% through that supply, well under the 85% DEA/PDMP threshold.
  const rawRequest = {
    drugName: 'Oxycodone',
    dosage: '10mg',
    daysSupply: 30,
    requestedFillDate: '2026-07-09',
  };
  const patientIdentifiers = { mrn: 'MRN-990211', dob: '1975-01-01' };

  printResult('Stage 1 Output (Rx Record + PDMP Lookup)', engine.ingest(rawRequest, patientIdentifiers));
  printResult(
    'Full Run Output (expected: blocked, DEA audit exception)',
    engine.run(rawRequest, patientIdentifiers)
  );
}

function runColdChainIotSentinelDemo() {
  printBanner('RUNNING AGENT 9: COLD-CHAIN IOT SENTINEL (Hub 3)');
  const engine = new ColdChainIotSentinel();
  const telemetryText = [
    'Unit: FRIDGE-7',
    'Product: Insulin Glargine',
    'Temperature: 9.4C',
    'Timestamp: 2026-07-09T02:15:00Z',
  ].join('\n');

  printResult('Stage 1 Output (Redacted Telemetry Record)', engine.ingest(telemetryText));
  printResult(
    'Full Run Output (expected: warming excursion, redistribution + facilities ticket)',
    engine.run(telemetryText)
  );
}

function runCompoundingAllergyAuditorDemo() {
  printBanner('RUNNING AGENT 10: COMPOUNDING ALLERGY AUDITOR (Hub 3)');
  const engine = new CompoundingAllergyAuditor();
  const formulaText = 'Normal Saline 500mL + Penicillin G 2000000 units + Dextrose 5%';
  const allergyProfile = ['Penicillins', 'Latex'];
  const patientIdentifiers = { mrn: 'MRN-334455', dob: '1990-09-09' };

  printResult(
    'Stage 1 Output (Components + Allergy Profile Record)',
    engine.ingest(formulaText, allergyProfile, patientIdentifiers)
  );
  printResult(
    'Full Run Output (expected: hard-blocked, cleanroom intercept)',
    engine.run(formulaText, allergyProfile, patientIdentifiers)
  );
}

function runCompanionToxicosisSentinelDemo() {
  printBanner('RUNNING AGENT 11: COMPANION TOXICOSIS SENTINEL (Hub 4)');
  const engine = new CompanionToxicosisSentinel();
  const rawText = [
    'Owner: Maria Gomez',
    'Pet Name: Buddy',
    'Species: Canine',
    'Breed: Labrador Retriever',
    'Age: 4',
    'Weight (kg): 28',
    'Ingested Substance: Baking Chocolate',
    'Estimated Ingested Grams: 200',
  ].join('\n');

  printResult('Stage 1 Output (Signalment Record)', engine.ingest(rawText));
  printResult(
    'Full Run Output (expected: toxic ratio >= 1, STAT decontamination alert)',
    engine.run(rawText)
  );
}

function runEquineTelemetryMewsDemo() {
  printBanner('RUNNING AGENT 12: EQUINE TELEMETRY MEWS (Hub 4)');
  const engine = new EquineTelemetryMews();
  const rawTelemetry = {
    horseId: 'HORSE-04521',
    heartRate: 68, // >60bpm: colic/shock indicator
    respirationRate: 28,
    temperatureCelsius: 38.9,
    capillaryRefillTime: 3, // >2s: poor perfusion
  };

  printResult('Stage 1 Output (Redacted Vitals Record)', engine.ingest(rawTelemetry));
  printResult(
    'Full Run Output (expected: EEWS >= 5, field surgeon paged)',
    engine.run(rawTelemetry)
  );
}

function runAvianExoticDosageGuardDemo() {
  printBanner('RUNNING AGENT 13: AVIAN/EXOTIC DOSAGE GUARD (Hub 4)');
  const engine = new AvianExoticDosageGuard();
  const rawRequest = {
    species: 'African Grey Parrot',
    weightGrams: 450,
    drugName: 'Meloxicam',
    requestedDosageMg: 0.5, // far exceeds the 0.2 mcg/g ceiling at this body weight
  };
  const patientIdentifiers = { ownerName: 'Diane Carter', petName: 'Kiwi' };

  printResult('Stage 1 Output (Rx Record)', engine.ingest(rawRequest, patientIdentifiers));
  printResult(
    'Full Run Output (expected: blocked, micro-dosing intercept)',
    engine.run(rawRequest, patientIdentifiers)
  );
}

function runShelterIntakeQuarantineRouterDemo() {
  printBanner('RUNNING AGENT 14: SHELTER INTAKE QUARANTINE ROUTER (Hub 4)');
  const engine = new ShelterIntakeQuarantineRouter();
  const intakeRecord = {
    strayId: 'STRAY-7788',
    species: 'Canine',
    symptoms: ['bloody diarrhea', 'vomiting', 'lethargy'],
  };
  const requestHeaders = { authorization: 'Bearer mock-oauth2-bearer-token-abcdef123456' };

  printResult('Stage 1 Output (Intake Record)', engine.ingest(intakeRecord));
  printResult(
    'Full Run Output (expected: parvovirus match, isolation ward + biohazard ticket)',
    engine.run(intakeRecord, requestHeaders)
  );
}

function runLivestockBiosecurityAnomalyDetectorDemo() {
  printBanner('RUNNING AGENT 15: LIVESTOCK BIOSECURITY ANOMALY DETECTOR (Hub 4)');
  const engine = new LivestockBiosecurityAnomalyDetector();
  const rawMetrics = {
    sectorCode: 'SECTOR-14',
    species: 'poultry_broiler',
    flockCount: 50000,
    previousDayMortality: 45,
    currentDayMortality: 210, // +366%: mortality spike
    previousDayWaterConsumptionLiters: 12000,
    currentDayWaterConsumptionLiters: 7000, // -42%: sharp water drop
    feedConsumptionKg: 4800,
  };

  printResult('Stage 1 Output (Production Metrics Record)', engine.ingest(rawMetrics));
  printResult(
    'Full Run Output (expected: outbreak detected, USDA report + logistics hold)',
    engine.run(rawMetrics)
  );
}

function runDicomStrokeTriageDemo() {
  printBanner('RUNNING AGENT 16: DICOM STROKE TRIAGE (Hub 5)');
  const engine = new DicomStrokeTriage();
  const rawHeaderText = [
    'Patient Name: Robert Chen',
    'Patient ID: MRN-882211',
    'Patient Birth Date: 1965-03-12',
    'Modality: CT',
    'Body Part Examined: HEAD',
    'Scan Protocol: CT Head Without Contrast - Stroke Protocol',
    'Hemorrhage Confidence Score: 0.91',
  ].join('\n');

  printResult('Stage 1 Output (Redacted DICOM Record)', engine.ingest(rawHeaderText));
  printResult(
    'Full Run Output (expected: CT + confidence >= 0.85, STAT neurology page)',
    engine.run(rawHeaderText)
  );
}

function runCriticalBiopsySentinelDemo() {
  printBanner('RUNNING AGENT 17: CRITICAL BIOPSY SENTINEL (Hub 5)');
  const engine = new CriticalBiopsySentinel();
  const rawText = [
    'MRN: MRN-334211',
    'DOB: 1978-11-05',
    'Accession Number: SP-2026-004471',
    'Specimen Source: Left forearm skin punch biopsy',
    'Findings: Sections reveal an asymmetric proliferation of atypical melanocytes consistent with malignant melanoma, Breslow depth 2.1mm.',
  ].join('\n');
  const requestHeaders = { authorization: 'Bearer mock-oauth2-bearer-token-abcdef123456' };

  printResult('Stage 1 Output (Pathology Record)', engine.ingest(rawText));
  printResult(
    'Full Run Output (expected: malignant melanoma match, expedited oncology ServiceRequest)',
    engine.run(rawText, requestHeaders)
  );
}

function runRadiologyPeerReviewAuditorDemo() {
  printBanner('RUNNING AGENT 18: RADIOLOGY PEER REVIEW AUDITOR (Hub 5)');
  const engine = new RadiologyPeerReviewAuditor();
  const humanReportText = 'Impression: No acute findings. Lungs are clear bilaterally. No acute cardiopulmonary process.';
  const aiTagText = 'AI_CV_TAG: Pulmonary Embolism (confidence 0.93)';
  const patientIdentifiers = { mrn: 'MRN-778121', dob: '1982-06-30' };

  printResult('Stage 1 Output (Report Record)', engine.ingest(humanReportText, aiTagText, patientIdentifiers));
  printResult(
    'Full Run Output (expected: AI/human discrepancy, Senior QA worklist task)',
    engine.run(humanReportText, aiTagText, patientIdentifiers)
  );
}

function runSpecimenMismatchGuardDemo() {
  printBanner('RUNNING AGENT 19: SPECIMEN MISMATCH GUARD (Hub 5)');
  const engine = new SpecimenMismatchGuard();
  const barcodeData = { specimenId: 'SPEC-99213', anatomicalSite: 'Left Lung', tissueCode: 'LUNG-PARENCHYMA' };
  const surgicalBooking = { scheduledAnatomicalSite: 'Right Lung', scheduledProcedure: 'Right upper lobectomy' };

  printResult('Stage 1 Output (Barcode + Booking Record)', engine.ingest(barcodeData, surgicalBooking));
  printResult(
    'Full Run Output (expected: site mismatch, hard-blocked with cleanroom alarm)',
    engine.run(barcodeData, surgicalBooking)
  );
}

function runRadiationSafetyDoseSentinelDemo() {
  printBanner('RUNNING AGENT 20: RADIATION SAFETY DOSE SENTINEL (Hub 5)');
  const engine = new RadiationSafetyDoseSentinel();
  const radiologyOrder = { modality: 'CT', bodyPartExamined: 'Abdomen', estimatedDlpMgyCm: 600 };
  // MRN-551122 is seeded in the mock tracking database with 42 mSv prior
  // cumulative exposure; this scan's ~9 mSv pushes the projected total to
  // 51 mSv, past the 50 mSv safety threshold.
  const patientIdentifiers = { mrn: 'MRN-551122', dob: '1970-01-01' };

  printResult('Stage 1 Output (Dose Record + Cumulative Lookup)', engine.ingest(radiologyOrder, patientIdentifiers));
  printResult(
    'Full Run Output (expected: overexposure risk, radiologist signature soft-block)',
    engine.run(radiologyOrder, patientIdentifiers)
  );
}

function runCardiacArrhythmiaDetectorDemo() {
  printBanner('RUNNING AGENT 21: CARDIAC ARRHYTHMIA DETECTOR (Hub 6)');
  const engine = new CardiacArrhythmiaDetector();
  const rawTelemetry = {
    mrn: 'MRN-661122',
    dob: '1955-05-20',
    heartRate: 172, // >160bpm
    rhythmStatus: 'unstable',
  };

  printResult('Stage 1 Output (Redacted Telemetry Record)', engine.ingest(rawTelemetry));
  printResult(
    'Full Run Output (expected: VENTRICULAR_TACHYCARDIA, cardiologist paged)',
    engine.run(rawTelemetry)
  );
}

function runDiabeticHypoglycemiaSentinelDemo() {
  printBanner('RUNNING AGENT 22: DIABETIC HYPOGLYCEMIA SENTINEL (Hub 6)');
  const engine = new DiabeticHypoglycemiaSentinel();
  const rawText = [
    'MRN: MRN-772233',
    'DOB: 1990-02-14',
    'Caregiver Phone: +1-555-0142',
    'Current Glucose: 52',
    'Drop Velocity: 4.5',
  ].join('\n');
  const patientIdentifiers = { mrn: 'MRN-772233', dob: '1990-02-14' };
  const requestHeaders = { authorization: 'Bearer mock-oauth2-bearer-token-abcdef123456' };

  printResult('Stage 1 Output (CGM Record)', engine.ingest(rawText, patientIdentifiers));
  printResult(
    'Full Run Output (expected: midnight crash risk, caregiver SMS alert)',
    engine.run(rawText, patientIdentifiers, requestHeaders)
  );
}

function runElderlyFallIotRouterDemo() {
  printBanner('RUNNING AGENT 23: ELDERLY FALL IOT ROUTER (Hub 6)');
  const engine = new ElderlyFallIotRouter();
  const rawAccelerometerData = {
    deviceId: 'WATCH-88213',
    gForceValue: 5.1, // >=4.5G
    noMotionDurationSeconds: 95, // >=60s
    latitude: 37.7749,
    longitude: -122.4194,
  };

  printResult('Stage 1 Output (Redacted Accelerometer Record)', engine.ingest(rawAccelerometerData));
  printResult(
    'Full Run Output (expected: ELDERLY_FALL_DETECTED, EMS dispatched)',
    engine.run(rawAccelerometerData)
  );
}

function runRespiratoryCopdTrackerDemo() {
  printBanner('RUNNING AGENT 24: RESPIRATORY COPD TRACKER (Hub 6)');
  const engine = new RespiratoryCopdTracker();
  // 72 hourly readings, all below the 88% threshold (84-87 range).
  const historicalSpO2 = Array.from({ length: 72 }, (_, i) => 84 + (i % 4));
  const rawHistory = { mrn: 'MRN-990044', dob: '1948-08-15', historicalSpO2 };

  printResult('Stage 1 Output (Redacted Oximeter History Record)', engine.ingest(rawHistory));
  printResult(
    'Full Run Output (expected: CHRONIC_RESPIRATORY_DISTRESS, telehealth booking)',
    engine.run(rawHistory)
  );
}

function runSmartPillboxAdherenceAuditorDemo() {
  printBanner('RUNNING AGENT 25: SMART PILLBOX ADHERENCE AUDITOR (Hub 6)');
  const engine = new SmartPillboxAdherenceAuditor();
  const now = Date.now();
  const rawPillboxData = {
    compartmentLabel: 'COMPARTMENT_3_EVENING_DOSE',
    openEventTimestamps: [
      new Date(now - 96 * 60 * 60 * 1000).toISOString(),
      new Date(now - 74 * 60 * 60 * 1000).toISOString(),
      new Date(now - 50 * 60 * 60 * 1000).toISOString(), // most recent open: 50h ago
    ],
  };
  const patientIdentifiers = { mrn: 'MRN-113355', dob: '1952-12-01' };

  printResult('Stage 1 Output (Redacted Pillbox Record)', engine.ingest(rawPillboxData, patientIdentifiers));
  printResult(
    'Full Run Output (expected: CRITICAL_MEDICATION_NON_ADHERENCE, pharmacy outreach)',
    engine.run(rawPillboxData, patientIdentifiers)
  );
}

function runCdtClaimScrubberDemo() {
  printBanner('RUNNING AGENT 26: CDT CLAIM SCRUBBER (Hub 7)');
  const engine = new CdtClaimScrubber();
  const rawClaim = {
    patientName: 'Alan Brooks',
    patientId: 'PT-55210',
    primaryCDTCode: 'D4341', // deep scaling
    secondaryCDTCode: 'D1110', // standard prophylaxis - conflicting pair
    quadrant: 'UR',
  };

  printResult('Stage 1 Output (Redacted Claim Record)', engine.ingest(rawClaim));
  printResult(
    'Full Run Output (expected: CDT_CODE_CONFLICT, blocked with correction ticket)',
    engine.run(rawClaim)
  );
}

function runXrayCariesSentinelDemo() {
  printBanner('RUNNING AGENT 27: X-RAY CARIES SENTINEL (Hub 7)');
  const engine = new XrayCariesSentinel();
  const rawText = [
    'Patient Name: Nina Patel',
    'Patient ID: PT-66312',
    'Tooth Number: 30',
    'Caries Confidence Score: 0.92',
  ].join('\n');

  printResult('Stage 1 Output (Redacted X-Ray Record)', engine.ingest(rawText));
  printResult(
    'Full Run Output (expected: HIGH_DECAY_DETECTION, patient case presentation)',
    engine.run(rawText)
  );
}

function runPeriodontalBoneLossAuditorDemo() {
  printBanner('RUNNING AGENT 28: PERIODONTAL BONE LOSS AUDITOR (Hub 7)');
  const engine = new PeriodontalBoneLossAuditor();
  const rawChart = {
    requestedProcedure: 'osseous_surgery',
    measurements: [
      { toothNumber: 14, pocketDepthMillimeters: 3 },
      { toothNumber: 15, pocketDepthMillimeters: 4 },
      { toothNumber: 16, pocketDepthMillimeters: 3.5 },
    ],
  };
  const patientIdentifiers = { mrn: 'MRN-DEN-4471', dob: '1985-03-02' };

  printResult('Stage 1 Output (Redacted Charting Record)', engine.ingest(rawChart, patientIdentifiers));
  printResult(
    'Full Run Output (expected: INSUFFICIENT_BONE_LOSS_EVIDENCE, pre-auth soft-block)',
    engine.run(rawChart, patientIdentifiers)
  );
}

function runTeledentistryTriageRouterDemo() {
  printBanner('RUNNING AGENT 29: TELEDENTISTRY TRIAGE ROUTER (Hub 7)');
  const engine = new TeledentistryTriageRouter();
  const messageText = "Hi, it's Saturday night and my face is really swollen on the right side near my jaw, it hurts a lot and is getting worse.";
  const patientIdentifiers = { mrn: 'MRN-DEN-9981', dob: '1995-07-18' };
  const messagingMetadata = { messageCount: 2 };

  printResult('Stage 1 Output (Redacted Message Record)', engine.ingest(messageText, patientIdentifiers, messagingMetadata));
  printResult(
    'Full Run Output (expected: critical priority, STAT oral surgeon page)',
    engine.run(messageText, patientIdentifiers, messagingMetadata)
  );
}

function runNitrousOxideSafetySentinelDemo() {
  printBanner('RUNNING AGENT 30: NITROUS OXIDE SAFETY SENTINEL (Hub 7)');
  const engine = new NitrousOxideSafetySentinel();
  const rawSensorData = {
    sensorId: 'N2O-SENSOR-OR3',
    ppmValue: 38, // >25ppm
    sustainedMinutesAboveThreshold: 7, // >5 minutes
  };

  printResult('Stage 1 Output (Redacted Sensor Record)', engine.ingest(rawSensorData));
  printResult(
    'Full Run Output (expected: HAZARDOUS_NITROUS_LEAK, manifold shutdown + facilities alarm)',
    engine.run(rawSensorData)
  );
}

function main() {
  runClaimsDenialDemo();
  runEdPredictorDemo();
  runPriorAuthFailDemo();
  runPriorAuthPassDemo();
  runDischargeOrchestratorDemo();
  runMedReconciliationDemo();
  runIcuAcuitySentinelDemo();
  runTelehealthTriageRouterDemo();
  runSubstanceComplianceGuardDemo();
  runColdChainIotSentinelDemo();
  runCompoundingAllergyAuditorDemo();
  runCompanionToxicosisSentinelDemo();
  runEquineTelemetryMewsDemo();
  runAvianExoticDosageGuardDemo();
  runShelterIntakeQuarantineRouterDemo();
  runLivestockBiosecurityAnomalyDetectorDemo();
  runDicomStrokeTriageDemo();
  runCriticalBiopsySentinelDemo();
  runRadiologyPeerReviewAuditorDemo();
  runSpecimenMismatchGuardDemo();
  runRadiationSafetyDoseSentinelDemo();
  runCardiacArrhythmiaDetectorDemo();
  runDiabeticHypoglycemiaSentinelDemo();
  runElderlyFallIotRouterDemo();
  runRespiratoryCopdTrackerDemo();
  runSmartPillboxAdherenceAuditorDemo();
  runCdtClaimScrubberDemo();
  runXrayCariesSentinelDemo();
  runPeriodontalBoneLossAuditorDemo();
  runTeledentistryTriageRouterDemo();
  runNitrousOxideSafetySentinelDemo();

  printBanner('DEMO SEQUENCE COMPLETE — 31 RUNS ACROSS 30 AGENTS');
}

main();
