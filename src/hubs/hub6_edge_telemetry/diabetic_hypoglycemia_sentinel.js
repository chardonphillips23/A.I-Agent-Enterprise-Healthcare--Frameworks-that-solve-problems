'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const CGM_ALLOWLIST = ['currentGlucose', 'dropVelocity', 'caregiverPhone'];

const FIELD_PATTERNS = {
  caregiverPhone: /caregiver phone:\s*([^\n]+)/i,
  currentGlucose: /current glucose:\s*(-?\d+(?:\.\d+)?)/i,
  dropVelocity: /drop velocity:\s*(-?\d+(?:\.\d+)?)/i,
};

const HYPOGLYCEMIA_GLUCOSE_THRESHOLD = 60;
const HYPOGLYCEMIA_VELOCITY_THRESHOLD = 3;

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

class DiabeticHypoglycemiaSentinel {
  // Stage 1 (CGM Ingestion): mrn/dob are only used to derive a hashed
  // subjectId; glucose reading, drop velocity, and the caregiver contact
  // needed for Stage 3 dispatch survive into the record.
  ingest(rawText, patientIdentifiers) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new TypeError('rawText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }
    const currentGlucoseMatch = rawText.match(FIELD_PATTERNS.currentGlucose);
    if (!currentGlucoseMatch) {
      throw new Error('rawText requires a Current Glucose reading');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      currentGlucose: parseFloat(currentGlucoseMatch[1]),
      dropVelocity: parseFloat(extractField(rawText, FIELD_PATTERNS.dropVelocity)) || 0,
      caregiverPhone: extractField(rawText, FIELD_PATTERNS.caregiverPhone) || null,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !CGM_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Crash Risk Rules): defense-in-depth guard, then
  // flag a severe crash risk on a low absolute reading or a steep drop.
  evaluateGlucoseCrash(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !CGM_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached crash evaluation stage`);
    }

    const criticalRisk = record.currentGlucose < HYPOGLYCEMIA_GLUCOSE_THRESHOLD || record.dropVelocity > HYPOGLYCEMIA_VELOCITY_THRESHOLD;
    return { criticalRisk, status: criticalRisk ? 'HYPOGLYCEMIC_CRASH_RISK' : 'STABLE' };
  }

  // Stage 3 (Integration): only reachable on a critical crash risk.
  buildCaregiverSmsAlert(record) {
    const destination = record.caregiverPhone || 'UNKNOWN_CAREGIVER';
    return `TWILIO-SMS|TO:${destination}|PRIORITY:URGENT|MESSAGE:Glucose alert - reading ${record.currentGlucose} mg/dL, drop velocity ${record.dropVelocity} mg/dL per minute. Please check on your family member immediately and administer fast-acting glucose if trained to do so.|SENT_AT:${new Date().toISOString()}`;
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

  // Stage 4 (Audit Telemetry): masked Splunk SIEM log — glucose reading
  // and caregiver contact are masked before they reach the log.
  buildSplunkEvent(record, crashResult, outcome, tokenValidation) {
    return {
      time: Date.now() / 1000,
      host: 'diabetic-hypoglycemia-sentinel',
      source: 'hub6_edge_telemetry/diabetic_hypoglycemia_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: crashResult.criticalRisk,
        status: crashResult.status,
        maskedGlucose: maskValue(record.currentGlucose),
        maskedCaregiverPhone: maskValue(record.caregiverPhone),
        tokenFingerprint: tokenValidation.tokenFingerprint,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawText, patientIdentifiers, requestHeaders) {
    const record = this.ingest(rawText, patientIdentifiers);
    const crashResult = this.evaluateGlucoseCrash(record);
    const smsAlert = crashResult.criticalRisk ? this.buildCaregiverSmsAlert(record) : null;
    const tokenValidation = this.validateSecuritySignature(requestHeaders);
    const splunkEvent = this.buildSplunkEvent(record, crashResult, smsAlert ? 'hypoglycemic_crash_alerted' : 'stable_reading', tokenValidation);
    return { smsAlert, status: crashResult.status, splunkEvent };
  }
}

module.exports = {
  DiabeticHypoglycemiaSentinel,
  HYPOGLYCEMIA_GLUCOSE_THRESHOLD,
  HYPOGLYCEMIA_VELOCITY_THRESHOLD,
  CGM_ALLOWLIST,
};
