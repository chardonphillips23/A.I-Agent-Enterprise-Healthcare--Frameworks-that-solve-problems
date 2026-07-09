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

  printBanner('DEMO SEQUENCE COMPLETE — 16 RUNS ACROSS 15 AGENTS');
}

main();
