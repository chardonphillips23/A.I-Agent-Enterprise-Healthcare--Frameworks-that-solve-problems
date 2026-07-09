'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const DOSE_ALLOWLIST = [
  'modality',
  'bodyPartExamined',
  'estimatedDlpMgyCm',
  'estimatedDoseMsv',
  'priorCumulativeMsv',
  'projectedCumulativeMsv',
];

const SAFETY_THRESHOLD_MSV = 50;

// Mock DLP (Dose Length Product) -> effective dose conversion factors
// (mSv per mGy·cm), simplified per body region.
const CONVERSION_FACTORS = {
  head: 0.0023,
  chest: 0.014,
  abdomen: 0.015,
  default: 0.015,
};

// Mock cumulative radiation exposure tracking database, keyed by the
// patient's raw MRN — this lookup can only happen in Stage 1, since that's
// the only stage still holding the raw identifier.
const MOCK_RADIATION_TRACKING_DATABASE = {
  'MRN-551122': { priorCumulativeMsv: 42 },
  'MRN-551123': { priorCumulativeMsv: 10 },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class RadiationSafetyDoseSentinel {
  // Stage 1 (Order Ingestion): look up the mock cumulative-exposure record
  // while the raw MRN is still available, then carry forward only the
  // derived dose fields plus a hashed subjectId.
  ingest(radiologyOrder, patientIdentifiers) {
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }
    const { modality, bodyPartExamined, estimatedDlpMgyCm } = radiologyOrder || {};
    if (!modality || !bodyPartExamined || estimatedDlpMgyCm == null) {
      throw new Error('radiologyOrder requires modality, bodyPartExamined, and estimatedDlpMgyCm');
    }

    const trackingRecord = MOCK_RADIATION_TRACKING_DATABASE[mrn] || { priorCumulativeMsv: 0 };
    const conversionFactor = CONVERSION_FACTORS[bodyPartExamined.toLowerCase()] || CONVERSION_FACTORS.default;
    const estimatedDoseMsv = Number(estimatedDlpMgyCm) * conversionFactor;
    const projectedCumulativeMsv = trackingRecord.priorCumulativeMsv + estimatedDoseMsv;

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      modality,
      bodyPartExamined,
      estimatedDlpMgyCm: Number(estimatedDlpMgyCm),
      estimatedDoseMsv,
      priorCumulativeMsv: trackingRecord.priorCumulativeMsv,
      projectedCumulativeMsv,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !DOSE_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Exposure Risk Screening): defense-in-depth
  // guard, then flag an overexposure risk if the projected lifetime
  // cumulative dose would reach or exceed the strict safety threshold.
  evaluateExposureRisk(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !DOSE_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached risk screening stage`);
    }

    const overexposureRisk = record.projectedCumulativeMsv >= SAFETY_THRESHOLD_MSV;
    return { overexposureRisk, marginMsv: SAFETY_THRESHOLD_MSV - record.projectedCumulativeMsv };
  }

  // Stage 3 (Integration): only reachable when the projected dose would
  // breach the safety threshold. A soft-block — the scan can still
  // proceed, but only with an active radiologist signature justifying it.
  buildSoftBlockWarning(record, riskResult) {
    return {
      alertType: 'radiation_safety_soft_block',
      subjectId: record.subjectId,
      headline: `Cumulative radiation exposure would reach ${record.projectedCumulativeMsv.toFixed(1)} mSv, exceeding the ${SAFETY_THRESHOLD_MSV} mSv lifetime safety threshold`,
      detail: `Prior cumulative dose ${record.priorCumulativeMsv.toFixed(1)} mSv + estimated new dose ${record.estimatedDoseMsv.toFixed(1)} mSv (${record.modality} ${record.bodyPartExamined}, DLP ${record.estimatedDlpMgyCm} mGy·cm).`,
      requestedAction: 'This order requires an active radiologist signature justifying medical necessity before the scan may proceed.',
      signatureRequired: true,
      marginMsv: riskResult.marginMsv,
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4 (Audit Telemetry): secure Splunk HEC compliance record
  // carrying the anonymized tracking fingerprint (the hashed subjectId).
  buildSplunkEvent(record, riskResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'radiation-safety-dose-sentinel',
      source: 'hub5_imaging_pathology/radiation_safety_dose_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        overexposureRisk: riskResult.overexposureRisk,
        estimatedDoseMsv: record.estimatedDoseMsv,
        projectedCumulativeMsv: record.projectedCumulativeMsv,
        modality: record.modality,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(radiologyOrder, patientIdentifiers) {
    const record = this.ingest(radiologyOrder, patientIdentifiers);
    const riskResult = this.evaluateExposureRisk(record);
    const softBlockWarning = riskResult.overexposureRisk ? this.buildSoftBlockWarning(record, riskResult) : null;
    const splunkEvent = this.buildSplunkEvent(
      record,
      riskResult,
      softBlockWarning ? 'soft_block_signature_required' : 'cleared_within_safety_threshold'
    );
    return { softBlockWarning, overexposureRisk: riskResult.overexposureRisk, projectedCumulativeMsv: record.projectedCumulativeMsv, splunkEvent };
  }
}

module.exports = {
  RadiationSafetyDoseSentinel,
  SAFETY_THRESHOLD_MSV,
  MOCK_RADIATION_TRACKING_DATABASE,
  DOSE_ALLOWLIST,
};
