'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const XRAY_ALLOWLIST = ['toothNumber', 'cariesConfidenceScore'];

const FIELD_PATTERNS = {
  patientName: /patient name:\s*([^\n]+)/i,
  patientId: /patient id:\s*([^\n]+)/i,
  toothNumber: /tooth number:\s*([^\n]+)/i,
  cariesConfidenceScore: /caries confidence score:\s*(\d*\.?\d+)/i,
};

const HIGH_DECAY_THRESHOLD = 0.85;

function hashSubjectId(patientName, patientId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${patientName}:${patientId}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

function extractField(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

class XrayCariesSentinel {
  // Stage 1 (Bitewing Annotation Ingestion): patient name/ID are only
  // used to derive a hashed subjectId; only tooth number and the CV
  // classifier's confidence score survive into the record.
  ingest(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new TypeError('rawText must be a non-empty string');
    }
    const patientName = extractField(rawText, FIELD_PATTERNS.patientName);
    const patientId = extractField(rawText, FIELD_PATTERNS.patientId);
    if (!patientName || !patientId) {
      throw new Error('rawText requires Patient Name and Patient ID to derive a subjectId');
    }
    const toothNumber = extractField(rawText, FIELD_PATTERNS.toothNumber);
    if (!toothNumber) {
      throw new Error('rawText requires Tooth Number');
    }

    const record = {
      subjectId: hashSubjectId(patientName, patientId),
      toothNumber,
      cariesConfidenceScore: parseFloat(extractField(rawText, FIELD_PATTERNS.cariesConfidenceScore)) || 0,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !XRAY_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Decay Risk Screening): defense-in-depth guard,
  // then flag a high-confidence decay finding.
  evaluateDecayRisk(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !XRAY_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached decay risk screening stage`);
    }

    const highDecay = record.cariesConfidenceScore >= HIGH_DECAY_THRESHOLD;
    return { highDecay, status: highDecay ? 'HIGH_DECAY_DETECTION' : 'ROUTINE_FINDING' };
  }

  // Stage 3 (Integration): only reachable on a high-confidence finding —
  // an interactive, patient-facing case presentation to support informed
  // treatment consent.
  buildPatientCaseVisualization(record, decayResult) {
    return `CASE-PRESENTATION|${record.subjectId}|TOOTH:${record.toothNumber}|FINDING:${decayResult.status}|CONFIDENCE:${record.cariesConfidenceScore}|VISUAL_AID:INTERACTIVE_3D_TOOTH_OVERLAY|PATIENT_EXPLANATION:This X-ray shows a high-confidence area of decay on tooth ${record.toothNumber} that our AI imaging analysis flagged for review with your dentist.|GENERATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): masked Splunk SIEM event on every reading.
  buildSplunkEvent(record, decayResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'xray-caries-sentinel',
      source: 'hub7_dental_operations/xray_caries_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        status: decayResult.status,
        cariesConfidenceScore: record.cariesConfidenceScore,
        maskedToothNumber: maskValue(record.toothNumber),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawText) {
    const record = this.ingest(rawText);
    const decayResult = this.evaluateDecayRisk(record);
    const casePresentation = decayResult.highDecay ? this.buildPatientCaseVisualization(record, decayResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, decayResult, casePresentation ? 'high_decay_case_presented' : 'routine_finding_logged');
    return { casePresentation, status: decayResult.status, splunkEvent };
  }
}

module.exports = {
  XrayCariesSentinel,
  HIGH_DECAY_THRESHOLD,
  XRAY_ALLOWLIST,
};
