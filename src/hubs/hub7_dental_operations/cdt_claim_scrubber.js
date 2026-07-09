'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const CLAIM_ALLOWLIST = ['primaryCDTCode', 'secondaryCDTCode', 'quadrant'];

const CONFLICTING_CODE_PAIR = { primary: 'D4341', secondary: 'D1110' };

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

class CdtClaimScrubber {
  // Stage 1 (Billing Code Ingestion): patient identity strings are only
  // used to derive a hashed subjectId; only the CDT codes and quadrant
  // survive into the record.
  ingest(rawClaim) {
    const { patientName, patientId, primaryCDTCode, secondaryCDTCode, quadrant } = rawClaim || {};
    if (!patientName || !patientId) {
      throw new Error('rawClaim requires patientName and patientId to derive a subjectId');
    }
    if (!primaryCDTCode || !secondaryCDTCode || !quadrant) {
      throw new Error('rawClaim requires primaryCDTCode, secondaryCDTCode, and quadrant');
    }

    const record = {
      subjectId: hashSubjectId(patientName, patientId),
      primaryCDTCode,
      secondaryCDTCode,
      quadrant,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !CLAIM_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (CDT Compliance Rules): defense-in-depth guard, then flag a
  // code conflict when deep scaling (D4341) and standard prophylaxis
  // (D1110) are billed together on the same quadrant.
  evaluateCdtCompliance(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !CLAIM_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached compliance evaluation stage`);
    }

    const conflict = record.primaryCDTCode === CONFLICTING_CODE_PAIR.primary && record.secondaryCDTCode === CONFLICTING_CODE_PAIR.secondary;
    return { conflict, status: conflict ? 'CDT_CODE_CONFLICT' : 'CLEARED' };
  }

  // Stage 3 (Integration): only reachable when Stage 2 clears the claim.
  buildClaimScrubbingPayload(record) {
    return `CDT-CLAIM-SCRUB|${record.subjectId}|QUADRANT:${record.quadrant}|PRIMARY:${record.primaryCDTCode}|SECONDARY:${record.secondaryCDTCode}|STATUS:VALIDATED|SCRUBBED_AT:${new Date().toISOString()}`;
  }

  // Stage 4a (Billing Desk Intercept): only reachable on a code conflict —
  // the scrubbed claim payload is never generated on this path.
  buildBillingCorrectionTicket(record) {
    return {
      channel: 'billing_desk_correction_queue',
      priority: 'hard_block',
      subjectId: record.subjectId,
      headline: `CDT code conflict: ${CONFLICTING_CODE_PAIR.primary} (deep scaling) billed alongside ${CONFLICTING_CODE_PAIR.secondary} (prophylaxis) on quadrant ${record.quadrant}`,
      detail: 'These two procedure codes cannot be billed together for the same quadrant on the same date of service per payer coding edits.',
      requestedAction: 'Remove one of the conflicting codes or bill on separate dates of service before resubmitting.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk event on every claim.
  buildSplunkEvent(record, complianceResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'cdt-claim-scrubber',
      source: 'hub7_dental_operations/cdt_claim_scrubber',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        status: complianceResult.status,
        quadrant: record.quadrant,
        maskedPrimaryCDTCode: maskValue(record.primaryCDTCode),
        maskedSecondaryCDTCode: maskValue(record.secondaryCDTCode),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawClaim) {
    const record = this.ingest(rawClaim);
    const complianceResult = this.evaluateCdtCompliance(record);

    if (!complianceResult.conflict) {
      const claimPayload = this.buildClaimScrubbingPayload(record);
      const splunkEvent = this.buildSplunkEvent(record, complianceResult, 'validated_and_transmitted');
      return { claimPayload, correctionTicket: null, splunkEvent };
    }

    const correctionTicket = this.buildBillingCorrectionTicket(record);
    const splunkEvent = this.buildSplunkEvent(record, complianceResult, 'blocked_code_conflict');
    return { claimPayload: null, correctionTicket, splunkEvent };
  }
}

module.exports = {
  CdtClaimScrubber,
  CONFLICTING_CODE_PAIR,
  CLAIM_ALLOWLIST,
};
