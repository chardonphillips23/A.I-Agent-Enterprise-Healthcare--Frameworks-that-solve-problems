'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const CHART_ALLOWLIST = ['requestedProcedure', 'measurements'];

const MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM = 5;

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class PeriodontalBoneLossAuditor {
  // Stage 1 (Charting Ingestion): mrn/dob are only used to derive a
  // hashed subjectId; only the requested procedure and per-tooth pocket
  // depth measurements survive into the record.
  ingest(rawChart, patientIdentifiers) {
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }
    const { requestedProcedure, measurements } = rawChart || {};
    if (!requestedProcedure) {
      throw new Error('rawChart requires requestedProcedure');
    }
    if (!Array.isArray(measurements) || measurements.length === 0) {
      throw new Error('rawChart requires a non-empty measurements array');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      requestedProcedure,
      measurements: measurements.map((m) => ({
        toothNumber: m.toothNumber,
        pocketDepthMillimeters: Number(m.pocketDepthMillimeters),
      })),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !CHART_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Pre-Authorization Compliance Rules): defense-in-depth guard,
  // then flag an exception if osseous surgery is requested without at
  // least one measured pocket depth of 5mm or more.
  evaluatePreAuth(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !CHART_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached pre-auth evaluation stage`);
    }

    const maxPocketDepth = Math.max(...record.measurements.map((m) => m.pocketDepthMillimeters));
    const requestsOsseousSurgery = record.requestedProcedure.toLowerCase().includes('osseous');
    const exception = requestsOsseousSurgery && maxPocketDepth < MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM;

    return { maxPocketDepth, exception, status: exception ? 'INSUFFICIENT_BONE_LOSS_EVIDENCE' : 'CLEARED' };
  }

  // Stage 3 (Integration): only reachable on a pre-auth exception. A
  // soft-block — the hygienist can still supply the missing evidence.
  buildSoftBlockRequest(record, preAuthResult) {
    return `PERIO-PREAUTH-SOFT-BLOCK|${record.subjectId}|PROCEDURE:${record.requestedProcedure}|MAX_POCKET_DEPTH_MM:${preAuthResult.maxPocketDepth}|REQUIRED_MIN_MM:${MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM}|ACTION_REQUIRED:APPEND_DIGITAL_RADIOGRAPHIC_MEASUREMENTS|REQUESTED_BY:HYGIENIST|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): tokenized Splunk record carrying a
  // pre-authorization variance fingerprint rather than the full chart.
  buildSplunkEvent(record, preAuthResult, outcome) {
    const varianceFingerprint = crypto
      .createHash('sha256')
      .update(`${record.requestedProcedure}:${preAuthResult.maxPocketDepth}`)
      .digest('hex')
      .slice(0, 12);

    return {
      time: Date.now() / 1000,
      host: 'periodontal-bone-loss-auditor',
      source: 'hub7_dental_operations/periodontal_bone_loss_auditor',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        exception: preAuthResult.exception,
        status: preAuthResult.status,
        maxPocketDepth: preAuthResult.maxPocketDepth,
        varianceFingerprint,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawChart, patientIdentifiers) {
    const record = this.ingest(rawChart, patientIdentifiers);
    const preAuthResult = this.evaluatePreAuth(record);
    const softBlockRequest = preAuthResult.exception ? this.buildSoftBlockRequest(record, preAuthResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, preAuthResult, softBlockRequest ? 'preauth_soft_blocked' : 'preauth_cleared');
    return { softBlockRequest, status: preAuthResult.status, splunkEvent };
  }
}

module.exports = {
  PeriodontalBoneLossAuditor,
  MIN_POCKET_DEPTH_FOR_OSSEOUS_SURGERY_MM,
  CHART_ALLOWLIST,
};
