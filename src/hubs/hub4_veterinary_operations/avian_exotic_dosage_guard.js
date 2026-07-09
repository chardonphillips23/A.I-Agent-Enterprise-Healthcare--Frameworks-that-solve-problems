'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const RX_ALLOWLIST = ['species', 'weightGrams', 'drugName', 'requestedDosageMg'];

// Mock micro-dosing safety ceilings for sub-1000g (avian/reptilian) patients.
const MICRO_DOSING_SAFETY_THRESHOLDS = {
  meloxicam: { maxMicrogramsPerGram: 0.2 },
  enrofloxacin: { maxMicrogramsPerGram: 10 },
  ivermectin: { maxMicrogramsPerGram: 0.2 },
};

function hashSubjectId(ownerName, petName) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${ownerName}:${petName}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class AvianExoticDosageGuard {
  // Stage 1 (Prescription Ingestion): owner/pet identifiers are only used
  // to derive a hashed subjectId; species, weight, drug, and dose survive.
  ingest(rawRequest, patientIdentifiers) {
    const { ownerName, petName } = patientIdentifiers || {};
    if (!ownerName || !petName) {
      throw new Error('patientIdentifiers requires ownerName and petName to derive a subjectId');
    }
    const { species, weightGrams, drugName, requestedDosageMg } = rawRequest || {};
    if (!species || !drugName || weightGrams == null || requestedDosageMg == null) {
      throw new Error('rawRequest requires species, weightGrams, drugName, and requestedDosageMg');
    }

    const record = {
      subjectId: hashSubjectId(ownerName, petName),
      species,
      weightGrams: Number(weightGrams),
      drugName,
      requestedDosageMg: Number(requestedDosageMg),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !RX_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Metabolic/Species Validation): defense-in-depth guard, then
  // apply the micro-dosing safety ceiling for sub-1000g patients. Fails
  // closed if the patient is a micro-patient but the drug has no threshold
  // on file, routing it to manual pharmacist review rather than approving.
  validateDosage(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !RX_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached validation stage`);
    }

    const isMicroPatient = record.weightGrams < 1000;
    const thresholdEntry = MICRO_DOSING_SAFETY_THRESHOLDS[record.drugName.toLowerCase()];
    let breach = false;
    let reason = null;
    let requestedMicrogramsPerGram = null;

    if (isMicroPatient && thresholdEntry) {
      requestedMicrogramsPerGram = (record.requestedDosageMg * 1000) / record.weightGrams;
      if (requestedMicrogramsPerGram > thresholdEntry.maxMicrogramsPerGram) {
        breach = true;
        reason = `Requested dose (${requestedMicrogramsPerGram.toFixed(2)} mcg/g) exceeds the micro-dosing safety ceiling of ${thresholdEntry.maxMicrogramsPerGram} mcg/g for ${record.drugName} in a ${record.weightGrams}g patient.`;
      }
    } else if (isMicroPatient && !thresholdEntry) {
      breach = true;
      reason = `No micro-dosing safety threshold on file for "${record.drugName}" in a sub-1000g patient — route to manual pharmacist review.`;
    }

    return { isMicroPatient, requestedMicrogramsPerGram, breach, cleared: !breach };
  }

  // Stage 3 (Integration): only reachable when Stage 2 clears the dose.
  buildCompoundingLabel(record) {
    return `CLEANROOM-LABEL|${record.subjectId}|SPECIES:${record.species}|DRUG:${record.drugName}|DOSE_MG:${record.requestedDosageMg}|WEIGHT_G:${record.weightGrams}|VERIFIED:TRUE|LABEL_ID:CL-${record.subjectId.slice(0, 10)}-${Date.now()}`;
  }

  // Stage 4a (Micro-Dosing Intercept): only reachable on a validation
  // breach — the compounding label is never generated on this path.
  buildMicroDosingIntercept(record, validationResult) {
    return {
      channel: 'pharmacist_micro_dosing_intercept',
      priority: 'active_warning',
      subjectId: record.subjectId,
      drugName: record.drugName,
      headline: 'Micro-dosing intercept: catastrophic overdose risk in sub-1000g patient',
      reason: validationResult.reason,
      requestedAction: 'Do not compound or dispense as ordered. Recalculate dose against a verified exotic-species formulary before proceeding.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): tokenized Splunk log — the drug name is
  // masked before it ever reaches the log.
  buildSplunkEvent(record, validationResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'avian-exotic-dosage-guard',
      source: 'hub4_veterinary_operations/avian_exotic_dosage_guard',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        drugName: maskValue(record.drugName),
        isMicroPatient: validationResult.isMicroPatient,
        breach: validationResult.breach,
        requestedMicrogramsPerGram: validationResult.requestedMicrogramsPerGram,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawRequest, patientIdentifiers) {
    const record = this.ingest(rawRequest, patientIdentifiers);
    const validationResult = this.validateDosage(record);

    if (validationResult.cleared) {
      const compoundingLabel = this.buildCompoundingLabel(record);
      const splunkEvent = this.buildSplunkEvent(record, validationResult, 'cleared_for_compounding');
      return { compoundingLabel, intercept: null, splunkEvent };
    }

    const intercept = this.buildMicroDosingIntercept(record, validationResult);
    const splunkEvent = this.buildSplunkEvent(record, validationResult, 'blocked_micro_dosing_exception');
    return { compoundingLabel: null, intercept, splunkEvent };
  }
}

module.exports = {
  AvianExoticDosageGuard,
  MICRO_DOSING_SAFETY_THRESHOLDS,
  RX_ALLOWLIST,
};
