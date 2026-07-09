'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const MESSAGING_ALLOWLIST = ['detectedFlags', 'messageCount', 'sessionDurationSeconds'];

const ACUTE_FLAG_DICTIONARY = {
  chest_pain: { pattern: /chest pain|chest tightness/i, triageLevel: 'critical', label: 'Chest pain / cardiac concern' },
  stroke: { pattern: /stroke|face drooping|slurred speech|one[- ]sided weakness/i, triageLevel: 'critical', label: 'Stroke symptoms' },
  suicide: { pattern: /suicide|kill myself|want to die|self[- ]harm/i, triageLevel: 'critical', label: 'Suicidal ideation / self-harm risk' },
  breathing: { pattern: /can'?t breathe|shortness of breath|difficulty breathing/i, triageLevel: 'urgent', label: 'Respiratory distress' },
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

class TelehealthTriageRouter {
  // Stage 1 (Chat Ingestion): the raw chat text is only ever read here, to
  // detect which acute-flag categories it matches. Only the resulting flag
  // keys and session metrics — never the chat text itself — survive.
  ingest(chatText, patientIdentifiers, messagingMetadata = {}) {
    if (typeof chatText !== 'string' || !chatText.trim()) {
      throw new TypeError('chatText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const detectedFlags = Object.keys(ACUTE_FLAG_DICTIONARY).filter((key) =>
      ACUTE_FLAG_DICTIONARY[key].pattern.test(chatText)
    );

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      detectedFlags,
      messageCount: Number(messagingMetadata.messageCount) || 1,
      sessionDurationSeconds: Number(messagingMetadata.sessionDurationSeconds) || 0,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !MESSAGING_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Triage Rules): defense-in-depth guard, then map
  // the detected flag keys to a triage level using the acute-flag dictionary.
  classifyTriage(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !MESSAGING_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached triage stage`);
    }

    const matchedEntries = record.detectedFlags.map((key) => ACUTE_FLAG_DICTIONARY[key]);
    const triageLevel = matchedEntries.some((entry) => entry.triageLevel === 'critical')
      ? 'critical'
      : matchedEntries.some((entry) => entry.triageLevel === 'urgent')
        ? 'urgent'
        : 'routine';
    const matchedLabels = matchedEntries.map((entry) => entry.label);

    return { triageLevel, matchedLabels, escalate: triageLevel !== 'routine' };
  }

  // Stage 3 (Integration): only built for escalated triage levels. Shapes
  // an instant digital routing link (WebRTC for critical, Twilio callback
  // for urgent) to connect the patient to a live clinician.
  buildRoutingPayload(record, triageResult) {
    return {
      channel: triageResult.triageLevel === 'critical' ? 'emergency_webrtc_escalation' : 'urgent_twilio_callback',
      subjectId: record.subjectId,
      triageLevel: triageResult.triageLevel,
      matchedFlags: triageResult.matchedLabels,
      routingTarget: triageResult.triageLevel === 'critical' ? 'ed_virtual_triage_room' : 'on_call_nurse_line',
      webrtcRoomToken: `wrtc-${record.subjectId.slice(0, 12)}-${Date.now()}`,
      twilioCallbackNumber: '+1-800-555-0100',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4 (Access Control Guard): reject the request outright if no
  // valid-looking OAuth2 bearer token is present.
  validateAccessToken(headers) {
    const authHeader = headers && headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Access denied: missing or malformed OAuth2 bearer token');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length < 20) {
      throw new Error('Access denied: OAuth2 token failed validation');
    }
    return { valid: true, tokenFingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) };
  }

  // Stage 4 (Audit Telemetry): masked Splunk SIEM log carrying a token
  // fingerprint rather than the raw bearer token.
  buildSplunkEvent(record, triageResult, routingPayload, tokenValidation) {
    return {
      time: Date.now() / 1000,
      host: 'telehealth-triage-router',
      source: 'hub2_clinical_operations/telehealth_triage_router',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: routingPayload ? 'escalation_routed' : 'routine_no_escalation',
        triageLevel: triageResult.triageLevel,
        maskedFlags: triageResult.matchedLabels.map((label) => maskValue(label)),
        tokenFingerprint: tokenValidation.tokenFingerprint,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(chatText, patientIdentifiers, messagingMetadata, requestHeaders) {
    const record = this.ingest(chatText, patientIdentifiers, messagingMetadata);
    const triageResult = this.classifyTriage(record);
    const routingPayload = triageResult.escalate ? this.buildRoutingPayload(record, triageResult) : null;
    const tokenValidation = this.validateAccessToken(requestHeaders);
    const splunkEvent = this.buildSplunkEvent(record, triageResult, routingPayload, tokenValidation);
    return { triageLevel: triageResult.triageLevel, routingPayload, splunkEvent };
  }
}

module.exports = {
  TelehealthTriageRouter,
  ACUTE_FLAG_DICTIONARY,
  MESSAGING_ALLOWLIST,
};
