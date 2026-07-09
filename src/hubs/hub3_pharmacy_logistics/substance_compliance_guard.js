'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const RX_ALLOWLIST = [
  'drugName',
  'dosage',
  'daysSupply',
  'requestedFillDate',
  'priorFillOnRecord',
  'percentPreviousSupplyExhausted',
];

const SCHEDULE_II_DRUGS = new Set(['oxycodone', 'fentanyl', 'morphine', 'hydromorphone', 'methadone']);

// Mock state PDMP (Prescription Drug Monitoring Program) database, keyed by
// the patient's raw MRN — this lookup can only happen in Stage 1, since
// that's the only stage still holding the raw identifier.
const MOCK_PDMP_DATABASE = {
  'MRN-990211': {
    oxycodone: { lastFillDate: '2026-06-20', daysSupply: 30 },
  },
  'MRN-990212': {
    oxycodone: { lastFillDate: '2026-05-01', daysSupply: 30 },
  },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class SubstanceComplianceGuard {
  // Stage 1 (Rx Ingestion): look up the mock PDMP record while the raw MRN
  // is still available, then carry forward only the derived compliance
  // fields (percent of prior supply exhausted) plus a hashed subjectId.
  ingest(rawRequest, patientIdentifiers) {
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }
    const { drugName, dosage, daysSupply, requestedFillDate } = rawRequest || {};
    if (!drugName || !dosage || !daysSupply || !requestedFillDate) {
      throw new Error('rawRequest requires drugName, dosage, daysSupply, and requestedFillDate');
    }

    const priorFillRecord = (MOCK_PDMP_DATABASE[mrn] || {})[drugName.toLowerCase()] || null;
    let percentPreviousSupplyExhausted = null;
    if (priorFillRecord) {
      const daysSinceLastFill = Math.floor(
        (new Date(requestedFillDate) - new Date(priorFillRecord.lastFillDate)) / (1000 * 60 * 60 * 24)
      );
      percentPreviousSupplyExhausted = Math.max(
        0,
        Math.min((daysSinceLastFill / priorFillRecord.daysSupply) * 100, 100)
      );
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      drugName,
      dosage,
      daysSupply: Number(daysSupply),
      requestedFillDate,
      priorFillOnRecord: Boolean(priorFillRecord),
      percentPreviousSupplyExhausted,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !RX_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (DEA/PDMP Compliance Rules): defense-in-depth guard, then flag
  // a breach if a Schedule II refill is requested before 85% of the prior
  // fill's days-supply has elapsed.
  checkDeaCompliance(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !RX_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached compliance stage`);
    }

    const isScheduleII = SCHEDULE_II_DRUGS.has(record.drugName.toLowerCase());
    let breach = false;
    let reason = null;

    if (isScheduleII && record.priorFillOnRecord && record.percentPreviousSupplyExhausted < 85) {
      breach = true;
      reason = `Refill requested at ${record.percentPreviousSupplyExhausted.toFixed(1)}% of previous ${record.drugName} supply exhausted; DEA/PDMP policy requires at least 85% exhaustion before an early refill.`;
    }

    return { isScheduleII, breach, reason, cleared: !breach };
  }

  // Stage 3 (Integration): only reachable when Stage 2 clears the refill.
  // Shapes a FHIR MedicationRequest carrying mock provenance-compliance
  // extensions confirming the PDMP check was performed.
  buildFhirMedicationRequest(record) {
    return {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${record.subjectId}` },
      medicationCodeableConcept: { text: record.drugName },
      dosageInstruction: [{ text: record.dosage }],
      dispenseRequest: { expectedSupplyDuration: { value: record.daysSupply, unit: 'd' } },
      extension: [{ url: 'urn:mock:dea-provenance-verified', valueBoolean: true }],
      meta: { tag: [{ system: 'urn:mock:pdmp-verified', code: 'cleared' }] },
    };
  }

  // Stage 4a (DEA Audit Exception): only reachable on a compliance breach.
  buildDeaAuditException(record, complianceResult) {
    return {
      channel: 'dea_compliance_exception_queue',
      priority: 'active_audit_exception',
      subjectId: record.subjectId,
      drugName: record.drugName,
      headline: 'DEA compliance breach: early refill request blocked',
      reason: complianceResult.reason,
      requestedAction: 'Do not dispense. Escalate to the pharmacist-in-charge for manual PDMP review before any further action.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): tokenized Splunk record — the drug name is
  // masked before it ever reaches the log.
  buildSplunkEvent(record, complianceResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'substance-compliance-guard',
      source: 'hub3_pharmacy_logistics/substance_compliance_guard',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        drugName: maskValue(record.drugName),
        isScheduleII: complianceResult.isScheduleII,
        breach: complianceResult.breach,
        percentPreviousSupplyExhausted: record.percentPreviousSupplyExhausted,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawRequest, patientIdentifiers) {
    const record = this.ingest(rawRequest, patientIdentifiers);
    const complianceResult = this.checkDeaCompliance(record);

    if (complianceResult.cleared) {
      const fhirPayload = this.buildFhirMedicationRequest(record);
      const splunkEvent = this.buildSplunkEvent(record, complianceResult, 'cleared_and_dispensed');
      return { fhirPayload, deaException: null, splunkEvent };
    }

    const deaException = this.buildDeaAuditException(record, complianceResult);
    const splunkEvent = this.buildSplunkEvent(record, complianceResult, 'blocked_dea_exception');
    return { fhirPayload: null, deaException, splunkEvent };
  }
}

module.exports = {
  SubstanceComplianceGuard,
  SCHEDULE_II_DRUGS,
  MOCK_PDMP_DATABASE,
  RX_ALLOWLIST,
};
