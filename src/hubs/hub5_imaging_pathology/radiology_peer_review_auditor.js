'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const REVIEW_ALLOWLIST = ['humanImpressionText', 'aiDiagnosticTag'];

const CRITICAL_FINDING_KEYWORDS = [
  'pulmonary embolism',
  'aortic dissection',
  'tension pneumothorax',
  'acute hemorrhage',
];

const NEGATIVE_LANGUAGE_PATTERNS = [/no acute findings/i, /unremarkable/i, /negative for acute/i, /within normal limits/i];

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class RadiologyPeerReviewAuditor {
  // Stage 1 (Report Ingestion): mrn/dob are only used to derive a hashed
  // subjectId; the human impression text and AI diagnostic tag are the
  // clinically necessary content Stage 2 compares against each other.
  ingest(humanReportText, aiTagText, patientIdentifiers) {
    if (typeof humanReportText !== 'string' || !humanReportText.trim()) {
      throw new TypeError('humanReportText must be a non-empty string');
    }
    if (typeof aiTagText !== 'string' || !aiTagText.trim()) {
      throw new TypeError('aiTagText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      humanImpressionText: humanReportText.trim(),
      aiDiagnosticTag: aiTagText.trim(),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !REVIEW_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Semantic Dissonance Check): defense-in-depth guard, then flag
  // a discrepancy if the AI tag names a critical finding while the human
  // report uses routine negative language.
  evaluateSemanticDissonance(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !REVIEW_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached dissonance check stage`);
    }

    const aiTagLower = record.aiDiagnosticTag.toLowerCase();
    const matchedCriticalFinding = CRITICAL_FINDING_KEYWORDS.find((keyword) => aiTagLower.includes(keyword)) || null;
    const humanIsNegative = NEGATIVE_LANGUAGE_PATTERNS.some((pattern) => pattern.test(record.humanImpressionText));
    const discrepancyDetected = Boolean(matchedCriticalFinding) && humanIsNegative;

    return { matchedCriticalFinding, humanIsNegative, discrepancyDetected };
  }

  // Stage 3 (Integration): only reachable on a detected discrepancy.
  // Routes the case into the mandatory Senior QA peer review worklist.
  buildPeerReviewWorklistTask(record, dissonanceResult) {
    return `QA-PEER-REVIEW-TASK|${record.subjectId}|PRIORITY:CRITICAL|AI_FINDING:${dissonanceResult.matchedCriticalFinding}|HUMAN_REPORT_STATUS:NEGATIVE_LANGUAGE_DETECTED|ROUTED_TO:SENIOR_QA_WORKLIST|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): tokenized Splunk record — the report text
  // never reaches the log, only a one-way content fingerprint and a
  // numeric variance index.
  buildSplunkEvent(record, dissonanceResult, outcome) {
    const contentFingerprint = crypto
      .createHash('sha256')
      .update(`${record.humanImpressionText}:${record.aiDiagnosticTag}`)
      .digest('hex')
      .slice(0, 16);

    return {
      time: Date.now() / 1000,
      host: 'radiology-peer-review-auditor',
      source: 'hub5_imaging_pathology/radiology_peer_review_auditor',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        discrepancyDetected: dissonanceResult.discrepancyDetected,
        diagnosticVarianceIndex: dissonanceResult.discrepancyDetected ? 1 : 0,
        contentFingerprint,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(humanReportText, aiTagText, patientIdentifiers) {
    const record = this.ingest(humanReportText, aiTagText, patientIdentifiers);
    const dissonanceResult = this.evaluateSemanticDissonance(record);
    const peerReviewTask = dissonanceResult.discrepancyDetected
      ? this.buildPeerReviewWorklistTask(record, dissonanceResult)
      : null;
    const splunkEvent = this.buildSplunkEvent(
      record,
      dissonanceResult,
      peerReviewTask ? 'critical_discrepancy_escalated' : 'concordant_read'
    );
    return { peerReviewTask, discrepancyDetected: dissonanceResult.discrepancyDetected, splunkEvent };
  }
}

module.exports = {
  RadiologyPeerReviewAuditor,
  CRITICAL_FINDING_KEYWORDS,
  NEGATIVE_LANGUAGE_PATTERNS,
  REVIEW_ALLOWLIST,
};
