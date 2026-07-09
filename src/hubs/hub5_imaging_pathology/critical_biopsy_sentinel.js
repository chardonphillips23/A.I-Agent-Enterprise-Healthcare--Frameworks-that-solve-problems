'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const BIOPSY_ALLOWLIST = ['accessionNumber', 'specimenSource', 'findings'];

const FIELD_PATTERNS = {
  mrn: /mrn:\s*([^\n]+)/i,
  dob: /dob:\s*([^\n]+)/i,
  accessionNumber: /accession number:\s*([^\n]+)/i,
  specimenSource: /specimen source:\s*([^\n]+)/i,
  findings: /findings:\s*([^\n]+)/i,
};

const MALIGNANCY_RISK_KEYS = [
  { pattern: /malignant melanoma/i, label: 'Malignant melanoma' },
  { pattern: /high-grade glioblastoma|glioblastoma multiforme/i, label: 'High-grade glioblastoma' },
  { pattern: /acute myeloid leukemia/i, label: 'Acute myeloid leukemia' },
  { pattern: /small cell lung carcinoma/i, label: 'Small cell lung carcinoma' },
];

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

function extractField(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

class CriticalBiopsySentinel {
  // Stage 1 (Pathology Ingestion): mrn/dob are only used to derive a
  // hashed subjectId; accession number, specimen source, and the findings
  // text needed for Stage 2's keyword screen survive into the record.
  ingest(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new TypeError('rawText must be a non-empty string');
    }
    const mrn = extractField(rawText, FIELD_PATTERNS.mrn);
    const dob = extractField(rawText, FIELD_PATTERNS.dob);
    if (!mrn || !dob) {
      throw new Error('rawText requires MRN and DOB to derive a subjectId');
    }
    const accessionNumber = extractField(rawText, FIELD_PATTERNS.accessionNumber);
    const specimenSource = extractField(rawText, FIELD_PATTERNS.specimenSource);
    if (!accessionNumber || !specimenSource) {
      throw new Error('rawText requires Accession Number and Specimen Source');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      accessionNumber,
      specimenSource,
      findings: extractField(rawText, FIELD_PATTERNS.findings) || '',
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !BIOPSY_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Malignancy Keyword Screening): defense-in-depth guard, then
  // regex-match the findings text against hyper-aggressive malignancy keys.
  screenMalignancy(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !BIOPSY_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached screening stage`);
    }

    const matched = MALIGNANCY_RISK_KEYS.filter((entry) => entry.pattern.test(record.findings)).map((entry) => entry.label);
    const highPriority = matched.length > 0;

    return { matched, highPriority, triageLevel: highPriority ? 'critical_escalation' : 'routine' };
  }

  // Stage 3 (Integration): only reachable on a high-priority match. Shapes
  // an expedited FHIR ServiceRequest targeted at oncology scheduling,
  // serialized as a payload string.
  buildOncologyServiceRequest(record, screenResult) {
    const serviceRequest = {
      resourceType: 'ServiceRequest',
      status: 'active',
      intent: 'order',
      priority: 'stat',
      subject: { reference: `Patient/${record.subjectId}` },
      category: [{ text: 'oncology-consult' }],
      code: { text: 'Expedited oncology consultation' },
      reasonCode: [{ text: screenResult.matched.join('; ') }],
      occurrenceDateTime: new Date().toISOString(),
      note: [{ text: `Accession ${record.accessionNumber}, specimen source: ${record.specimenSource}` }],
    };
    return JSON.stringify(serviceRequest);
  }

  // Stage 4 (Access Control Guard): reject the request outright if no
  // valid-looking security signature is present.
  validateSecuritySignature(headers) {
    const authHeader = headers && headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Access denied: missing or malformed security signature');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length < 20) {
      throw new Error('Access denied: security signature failed validation');
    }
    return { valid: true, tokenFingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) };
  }

  // Stage 4 (Audit Telemetry): masked Splunk SIEM event — specimen details
  // are masked before they reach the log.
  buildSplunkEvent(record, screenResult, outcome, tokenValidation) {
    return {
      time: Date.now() / 1000,
      host: 'critical-biopsy-sentinel',
      source: 'hub5_imaging_pathology/critical_biopsy_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        triageLevel: screenResult.triageLevel,
        maskedAccessionNumber: maskValue(record.accessionNumber),
        maskedSpecimenSource: maskValue(record.specimenSource),
        tokenFingerprint: tokenValidation.tokenFingerprint,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawText, requestHeaders) {
    const record = this.ingest(rawText);
    const screenResult = this.screenMalignancy(record);
    const serviceRequestPayload = screenResult.highPriority ? this.buildOncologyServiceRequest(record, screenResult) : null;
    const tokenValidation = this.validateSecuritySignature(requestHeaders);
    const splunkEvent = this.buildSplunkEvent(
      record,
      screenResult,
      serviceRequestPayload ? 'critical_oncology_escalation' : 'routine_pathology_review',
      tokenValidation
    );
    return { serviceRequestPayload, triageLevel: screenResult.triageLevel, splunkEvent };
  }
}

module.exports = {
  CriticalBiopsySentinel,
  MALIGNANCY_RISK_KEYS,
  BIOPSY_ALLOWLIST,
};
