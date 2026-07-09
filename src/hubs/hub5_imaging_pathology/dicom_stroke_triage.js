'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const DICOM_ALLOWLIST = ['modality', 'bodyPartExamined', 'scanProtocol', 'hemorrhageConfidenceScore'];

const FIELD_PATTERNS = {
  patientName: /patient name:\s*([^\n]+)/i,
  patientId: /patient id:\s*([^\n]+)/i,
  modality: /modality:\s*([^\n]+)/i,
  bodyPartExamined: /body part examined:\s*([^\n]+)/i,
  scanProtocol: /scan protocol:\s*([^\n]+)/i,
  hemorrhageScore: /hemorrhage confidence score:\s*(\d*\.?\d+)/i,
};

const HEMORRHAGE_ALERT_THRESHOLD = 0.85;

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

class DicomStrokeTriage {
  // Stage 1 (DICOM Header Ingestion): PatientName/PatientID tags are only
  // used to derive a hashed subjectId; only imaging metadata and the
  // simulated hemorrhage classifier score survive into the record.
  ingest(rawHeaderText) {
    if (typeof rawHeaderText !== 'string' || !rawHeaderText.trim()) {
      throw new TypeError('rawHeaderText must be a non-empty string');
    }
    const patientName = extractField(rawHeaderText, FIELD_PATTERNS.patientName);
    const patientId = extractField(rawHeaderText, FIELD_PATTERNS.patientId);
    if (!patientName || !patientId) {
      throw new Error('rawHeaderText requires Patient Name and Patient ID to derive a subjectId');
    }

    const record = {
      subjectId: hashSubjectId(patientName, patientId),
      modality: extractField(rawHeaderText, FIELD_PATTERNS.modality) || 'unknown',
      bodyPartExamined: extractField(rawHeaderText, FIELD_PATTERNS.bodyPartExamined) || 'unknown',
      scanProtocol: extractField(rawHeaderText, FIELD_PATTERNS.scanProtocol) || 'unknown',
      hemorrhageConfidenceScore: parseFloat(extractField(rawHeaderText, FIELD_PATTERNS.hemorrhageScore)) || 0,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !DICOM_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Stroke Risk Screening): defense-in-depth guard,
  // then flag a critical stroke alert only on CT modality at or above the
  // hemorrhage confidence threshold.
  evaluateStrokeRisk(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !DICOM_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached screening stage`);
    }

    const isCT = record.modality.toUpperCase().includes('CT');
    const criticalRisk = isCT && record.hemorrhageConfidenceScore >= HEMORRHAGE_ALERT_THRESHOLD;

    return { isCT, criticalRisk };
  }

  // Stage 3 (Integration): HL7 v2 MDM^T02 document notification — runs on
  // every read, since the notification documents the study regardless of
  // outcome.
  buildMdmStrokeNotification(record, riskResult) {
    const now = new Date();
    const hl7Timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const messageId = `MSG${now.getTime()}`;

    const segments = [
      `MSH|^~\\&|DICOM_STROKE_TRIAGE|RADIOLOGY|CLINICAL_ALERTING|HOSPITAL|${hl7Timestamp}||MDM^T02|${messageId}|P|2.5`,
      `PID|1||${record.subjectId}`,
      `TXA|1|RA^Radiology Report|TEXT|||||||${record.subjectId}||||AV`,
      `OBX|1|ST|MODALITY^Modality||${record.modality}||||||F`,
      `OBX|2|ST|BODYPART^Body Part Examined||${record.bodyPartExamined}||||||F`,
      `OBX|3|NM|ICH_SCORE^Hemorrhage Confidence Score||${record.hemorrhageConfidenceScore}||||||${riskResult.criticalRisk ? 'A' : 'F'}`,
    ];

    return segments.join('\r');
  }

  // Stage 4a (Neurology Sentinel Intercept): only built when the critical
  // hemorrhage threshold is met on a CT study.
  buildNeurologyPagerDispatch(record) {
    return {
      channel: 'stat_neurology_pager',
      priority: 'stat',
      subjectId: record.subjectId,
      headline: `STAT: acute intracranial hemorrhage suspected — confidence ${record.hemorrhageConfidenceScore}`,
      detail: `${record.modality} ${record.bodyPartExamined} (protocol: ${record.scanProtocol}) flagged by AI hemorrhage classifier at ${(record.hemorrhageConfidenceScore * 100).toFixed(1)}% confidence.`,
      requestedAction: 'STAT neurology consult required; activate stroke protocol immediately.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk event on every read.
  buildSplunkEvent(record, riskResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'dicom-stroke-triage',
      source: 'hub5_imaging_pathology/dicom_stroke_triage',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: riskResult.criticalRisk,
        hemorrhageConfidenceScore: record.hemorrhageConfidenceScore,
        modality: record.modality,
        maskedBodyPart: maskValue(record.bodyPartExamined),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawHeaderText) {
    const record = this.ingest(rawHeaderText);
    const riskResult = this.evaluateStrokeRisk(record);
    const mdmMessage = this.buildMdmStrokeNotification(record, riskResult);
    const pagerDispatch = riskResult.criticalRisk ? this.buildNeurologyPagerDispatch(record) : null;
    const splunkEvent = this.buildSplunkEvent(record, riskResult, pagerDispatch ? 'stat_neurology_paged' : 'routine_read');
    return { mdmMessage, pagerDispatch, splunkEvent, criticalRisk: riskResult.criticalRisk };
  }
}

module.exports = {
  DicomStrokeTriage,
  DICOM_ALLOWLIST,
  HEMORRHAGE_ALERT_THRESHOLD,
};
