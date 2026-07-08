'use strict';

const { ClaimsDenialAppealsEngine } = require('./hubs/hub1_revenue_cycle/claims_denial');
const { EdBedCapacityPredictor } = require('./hubs/hub2_clinical_operations/predictor');
const { PriorAuthCoordinator } = require('./hubs/hub2_clinical_operations/prior_auth');
const { DischargeOrchestrator } = require('./hubs/hub2_clinical_operations/discharge_orchestrator');
const { MedReconciliationSentinel } = require('./hubs/hub2_clinical_operations/med_reconciliation');

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

function main() {
  runClaimsDenialDemo();
  runEdPredictorDemo();
  runPriorAuthFailDemo();
  runPriorAuthPassDemo();
  runDischargeOrchestratorDemo();
  runMedReconciliationDemo();

  printBanner('DEMO SEQUENCE COMPLETE — 6 RUNS ACROSS 5 AGENTS');
}

main();
