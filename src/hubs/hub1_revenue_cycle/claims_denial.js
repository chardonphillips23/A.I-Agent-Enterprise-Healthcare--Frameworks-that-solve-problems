'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const CLAIM_ALLOWLIST = [
  'claimId',
  'payer',
  'carcCodes',
  'billedAmount',
  'dateOfServiceMonth',
  'denialDate',
  'suppliedDocs',
];

const CARC_CATEGORY_MAP = {
  '11': 'coding_error',
  '16': 'missing_information',
  '18': 'duplicate_claim',
  '29': 'timely_filing',
  '50': 'medical_necessity',
  '96': 'non_covered_service',
  '97': 'bundled_service',
  '197': 'missing_authorization',
  '204': 'plan_exclusion',
};

const CATEGORY_APPEAL_PROFILE = {
  coding_error: { appealable: true, deadlineDays: 90, requiredDocs: ['corrected_claim', 'coding_rationale'] },
  missing_information: { appealable: true, deadlineDays: 90, requiredDocs: ['missing_field_correction'] },
  duplicate_claim: { appealable: false, deadlineDays: 0, requiredDocs: [] },
  timely_filing: { appealable: true, deadlineDays: 30, requiredDocs: ['proof_of_timely_submission'] },
  medical_necessity: { appealable: true, deadlineDays: 180, requiredDocs: ['clinical_notes', 'physician_letter', 'medical_literature'] },
  non_covered_service: { appealable: false, deadlineDays: 0, requiredDocs: [] },
  bundled_service: { appealable: true, deadlineDays: 90, requiredDocs: ['ncci_edit_rationale', 'modifier_justification'] },
  missing_authorization: { appealable: true, deadlineDays: 60, requiredDocs: ['retro_auth_request', 'clinical_notes'] },
  plan_exclusion: { appealable: false, deadlineDays: 0, requiredDocs: [] },
  unclassified: { appealable: true, deadlineDays: 90, requiredDocs: ['manual_review'] },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class ClaimsDenialAppealsEngine {
  // Stage 1: strip direct identifiers, retain only allowlisted claim/billing
  // fields plus a one-way pseudonymous subject ID for downstream correlation.
  redact(rawDenial) {
    if (!rawDenial || typeof rawDenial !== 'object') {
      throw new TypeError('rawDenial must be an object');
    }
    const { mrn, dob, claimId, payer, carcCodes, billedAmount, dateOfService, denialDate, suppliedDocs } = rawDenial;
    if (!mrn || !dob || !claimId || !payer || !Array.isArray(carcCodes) || carcCodes.length === 0) {
      throw new Error('rawDenial requires mrn, dob, claimId, payer, and non-empty carcCodes');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      claimId,
      payer,
      carcCodes: carcCodes.map(String),
      billedAmount: Number(billedAmount) || 0,
      dateOfServiceMonth: dateOfService ? new Date(dateOfService).toISOString().slice(0, 7) : null,
      denialDate: denialDate ? new Date(denialDate) : new Date(),
      suppliedDocs: Array.isArray(suppliedDocs) ? suppliedDocs : [],
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !CLAIM_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2: CARC-driven denial classification and appeal-priority score,
  // with a defense-in-depth check that no un-allowlisted field leaked through.
  score(redactedRecord) {
    const leaked = Object.keys(redactedRecord).find(
      (key) => key !== 'subjectId' && !CLAIM_ALLOWLIST.includes(key)
    );
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached scoring stage`);
    }

    const categories = redactedRecord.carcCodes.map((code) => CARC_CATEGORY_MAP[code] || 'unclassified');
    const primaryCategory = categories[0];
    const profile = CATEGORY_APPEAL_PROFILE[primaryCategory];

    const appealDeadline = new Date(redactedRecord.denialDate);
    appealDeadline.setDate(appealDeadline.getDate() + profile.deadlineDays);
    const daysRemaining = Math.ceil((appealDeadline - new Date()) / (1000 * 60 * 60 * 24));

    const missingDocs = profile.requiredDocs.filter((doc) => !redactedRecord.suppliedDocs.includes(doc));

    let priorityScore = 0;
    if (profile.appealable) {
      priorityScore += Math.min(redactedRecord.billedAmount / 100, 50);
      if (daysRemaining <= 14) priorityScore += 30;
      else if (daysRemaining <= 30) priorityScore += 15;
      priorityScore += missingDocs.length === 0 ? 20 : 0;
    }

    let priorityTier;
    if (!profile.appealable) priorityTier = 'none';
    else if (priorityScore >= 60) priorityTier = 'high';
    else if (priorityScore >= 30) priorityTier = 'medium';
    else priorityTier = 'low';

    return {
      ...redactedRecord,
      primaryCategory,
      appealable: profile.appealable,
      requiredDocs: profile.requiredDocs,
      missingDocs,
      appealDeadline,
      priorityScore,
      priorityTier,
    };
  }

  // Stage 3: shape a UiPath Orchestrator queue-item payload for the
  // appeal-filing/resubmission RPA robot to pick up and execute.
  buildRpaPayload(scoredRecord) {
    const priorityMap = { high: 'High', medium: 'Normal', low: 'Low', none: 'Low' };
    const now = new Date();
    const action = !scoredRecord.appealable
      ? 'write_off'
      : scoredRecord.missingDocs.length === 0
        ? 'submit_appeal'
        : 'gather_documentation';

    return {
      queueName: 'CLAIMS_APPEAL_RPA_QUEUE',
      priority: priorityMap[scoredRecord.priorityTier],
      reference: `${scoredRecord.subjectId}-${scoredRecord.claimId}-${now.getTime()}`,
      dueDate: scoredRecord.appealable ? scoredRecord.appealDeadline.toISOString() : null,
      specificContent: {
        subjectId: scoredRecord.subjectId,
        claimId: scoredRecord.claimId,
        payer: scoredRecord.payer,
        action,
        denialCategory: scoredRecord.primaryCategory,
        missingDocs: scoredRecord.missingDocs,
        priorityTier: scoredRecord.priorityTier,
        requestedAt: now.toISOString(),
      },
    };
  }

  // Stage 4: format a Splunk HTTP Event Collector (HEC) event for the
  // audit trail — pseudonymous ID and outcome metadata only, no PHI.
  buildSplunkEvent(rpaPayload) {
    return {
      time: Date.now() / 1000,
      host: 'claims-denial-appeals-engine',
      source: 'hub1_billing/claims_denial',
      sourcetype: '_json',
      event: {
        subjectId: rpaPayload.specificContent.subjectId,
        claimId: rpaPayload.specificContent.claimId,
        action: rpaPayload.specificContent.action,
        denialCategory: rpaPayload.specificContent.denialCategory,
        priorityTier: rpaPayload.specificContent.priorityTier,
        queueReference: rpaPayload.reference,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawDenial) {
    const redacted = this.redact(rawDenial);
    const scored = this.score(redacted);
    const rpaPayload = this.buildRpaPayload(scored);
    const splunkEvent = this.buildSplunkEvent(rpaPayload);
    return { rpaPayload, splunkEvent };
  }
}

module.exports = {
  ClaimsDenialAppealsEngine,
  CARC_CATEGORY_MAP,
  CATEGORY_APPEAL_PROFILE,
};
