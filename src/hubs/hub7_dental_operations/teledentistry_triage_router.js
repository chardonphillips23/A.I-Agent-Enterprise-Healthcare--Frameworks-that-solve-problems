'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const MESSAGING_ALLOWLIST = ['detectedFlags', 'messageCount'];

const MAXILLOFACIAL_EMERGENCY_DICTIONARY = {
  swelling: { pattern: /swelling|swollen/i, priorityTier: 'critical', label: 'Facial/oral swelling' },
  cannot_swallow: { pattern: /cannot swallow|can't swallow|difficulty swallowing/i, priorityTier: 'critical', label: 'Difficulty swallowing (airway risk)' },
  avulsed_tooth: { pattern: /avulsed tooth|knocked out tooth|tooth knocked out/i, priorityTier: 'critical', label: 'Avulsed (knocked-out) tooth' },
  broken_jaw: { pattern: /broken jaw|jaw fracture|fractured jaw/i, priorityTier: 'critical', label: 'Suspected jaw fracture' },
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

class TeledentistryTriageRouter {
  // Stage 1 (Message Ingestion): the raw message text is only read here
  // to detect emergency flag matches; only the resulting flag keys and a
  // message-count metric survive — never the message text itself.
  ingest(messageText, patientIdentifiers, messagingMetadata = {}) {
    if (typeof messageText !== 'string' || !messageText.trim()) {
      throw new TypeError('messageText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const detectedFlags = Object.keys(MAXILLOFACIAL_EMERGENCY_DICTIONARY).filter((key) =>
      MAXILLOFACIAL_EMERGENCY_DICTIONARY[key].pattern.test(messageText)
    );

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      detectedFlags,
      messageCount: Number(messagingMetadata.messageCount) || 1,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !MESSAGING_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Triage Rules): defense-in-depth guard, then map
  // detected flags to a priority tier.
  classifyEmergencyTier(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !MESSAGING_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached triage stage`);
    }

    const matchedEntries = record.detectedFlags.map((key) => MAXILLOFACIAL_EMERGENCY_DICTIONARY[key]);
    const priorityTier = matchedEntries.some((entry) => entry.priorityTier === 'critical') ? 'critical' : 'routine';
    const matchedLabels = matchedEntries.map((entry) => entry.label);

    return { priorityTier, matchedLabels, escalate: priorityTier !== 'routine' };
  }

  // Stage 3 (Integration): whiteboard webhook update — runs on every
  // message, since the clinic whiteboard reflects every incoming case.
  buildWhiteboardWebhookPayload(record, triageResult) {
    return `WEBHOOK-WHITEBOARD-UPDATE|${record.subjectId}|PRIORITY_TIER:${triageResult.priorityTier}|FLAGS:${triageResult.matchedLabels.join(', ') || 'none'}|ROUTED_TO:EMERGENCY_WHITEBOARD|UPDATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4a (Oral Surgeon Sentinel Intercept): only built on a critical
  // priority tier.
  buildOralSurgeonPage(record, triageResult) {
    return {
      channel: 'oral_surgeon_stat_text',
      priority: 'stat',
      subjectId: record.subjectId,
      headline: `STAT: after-hours maxillofacial emergency — ${triageResult.matchedLabels.join('; ')}`,
      requestedAction: 'On-call oral surgeon must contact the patient immediately and advise on ED referral if airway compromise is suspected.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk record on every message.
  buildSplunkEvent(record, triageResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'teledentistry-triage-router',
      source: 'hub7_dental_operations/teledentistry_triage_router',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        priorityTier: triageResult.priorityTier,
        maskedFlags: triageResult.matchedLabels.map((label) => maskValue(label)),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(messageText, patientIdentifiers, messagingMetadata) {
    const record = this.ingest(messageText, patientIdentifiers, messagingMetadata);
    const triageResult = this.classifyEmergencyTier(record);
    const webhookPayload = this.buildWhiteboardWebhookPayload(record, triageResult);
    const surgeonPage = triageResult.escalate ? this.buildOralSurgeonPage(record, triageResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, triageResult, surgeonPage ? 'stat_surgeon_paged' : 'routine_routed');
    return { webhookPayload, surgeonPage, splunkEvent, priorityTier: triageResult.priorityTier };
  }
}

module.exports = {
  TeledentistryTriageRouter,
  MAXILLOFACIAL_EMERGENCY_DICTIONARY,
  MESSAGING_ALLOWLIST,
};
