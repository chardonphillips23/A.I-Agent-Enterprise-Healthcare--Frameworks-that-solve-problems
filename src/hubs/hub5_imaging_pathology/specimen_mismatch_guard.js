'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const SPECIMEN_ALLOWLIST = ['anatomicalSite', 'tissueCode', 'scheduledAnatomicalSite', 'scheduledProcedure'];

function hashTrackingId(specimenId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${specimenId}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

function normalize(str) {
  return String(str).toLowerCase().trim();
}

class SpecimenMismatchGuard {
  // Stage 1 (Barcode & Booking Ingestion): the raw specimenId is only used
  // to derive a hashed trackingId; site/procedure fields from both the
  // barcode scan and the surgical booking feed survive for cross-checking.
  ingest(barcodeData, surgicalBooking) {
    const { specimenId, anatomicalSite, tissueCode } = barcodeData || {};
    if (!specimenId) {
      throw new Error('barcodeData requires specimenId to derive a trackingId');
    }
    if (!anatomicalSite || !tissueCode) {
      throw new Error('barcodeData requires anatomicalSite and tissueCode');
    }
    const { scheduledAnatomicalSite, scheduledProcedure } = surgicalBooking || {};
    if (!scheduledAnatomicalSite || !scheduledProcedure) {
      throw new Error('surgicalBooking requires scheduledAnatomicalSite and scheduledProcedure');
    }

    const record = {
      trackingId: hashTrackingId(specimenId),
      anatomicalSite,
      tissueCode,
      scheduledAnatomicalSite,
      scheduledProcedure,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'trackingId' && !SPECIMEN_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Match Verification): defense-in-depth guard, then compare the
  // barcode's anatomical site against the live surgical itinerary.
  verifyMatch(record) {
    const leaked = Object.keys(record).find((key) => key !== 'trackingId' && !SPECIMEN_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached verification stage`);
    }

    const mismatch = normalize(record.anatomicalSite) !== normalize(record.scheduledAnatomicalSite);
    return { mismatch, cleared: !mismatch };
  }

  // Stage 3 (Integration): a hard-block hold payload on mismatch, or a
  // cleared-for-processing payload when the site matches.
  buildLabDashboardPayload(record, matchResult) {
    if (matchResult.mismatch) {
      return {
        payloadType: 'lab_dashboard_hard_block_hold',
        trackingId: record.trackingId,
        status: 'HELD_MISMATCH_EXCEPTION',
        barcodeSite: record.anatomicalSite,
        scheduledSite: record.scheduledAnatomicalSite,
        requestedAction: 'Processing hard-blocked. Do not proceed until specimen identity is manually reconciled against the surgical record.',
        heldAt: new Date().toISOString(),
      };
    }
    return {
      payloadType: 'lab_dashboard_cleared_for_processing',
      trackingId: record.trackingId,
      status: 'VERIFIED_MATCH',
      anatomicalSite: record.anatomicalSite,
      clearedAt: new Date().toISOString(),
    };
  }

  // Stage 4a (Cleanroom Terminal Alarm): only reachable on a mismatch.
  buildCleanroomAlarmTicket(record) {
    return {
      channel: 'cleanroom_terminal_alarm',
      priority: 'catastrophic_exception',
      trackingId: record.trackingId,
      headline: 'CATASTROPHIC SPECIMEN MISMATCH: barcode site does not match surgical itinerary',
      detail: `Specimen labeled "${record.anatomicalSite}" (tissue code ${record.tissueCode}) conflicts with the active surgical booking for "${record.scheduledAnatomicalSite}" (${record.scheduledProcedure}).`,
      requestedAction: 'Sound the audible cleanroom terminal alarm. Halt all specimen processing immediately and escalate to the surgical team and lab director for manual identity reconciliation.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk audit event on every check.
  buildSplunkEvent(record, matchResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'specimen-mismatch-guard',
      source: 'hub5_imaging_pathology/specimen_mismatch_guard',
      sourcetype: '_json',
      event: {
        trackingId: record.trackingId,
        action: outcome,
        mismatch: matchResult.mismatch,
        maskedBarcodeSite: maskValue(record.anatomicalSite),
        maskedScheduledSite: maskValue(record.scheduledAnatomicalSite),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(barcodeData, surgicalBooking) {
    const record = this.ingest(barcodeData, surgicalBooking);
    const matchResult = this.verifyMatch(record);
    const dashboardPayload = this.buildLabDashboardPayload(record, matchResult);
    const alarmTicket = matchResult.mismatch ? this.buildCleanroomAlarmTicket(record) : null;
    const splunkEvent = this.buildSplunkEvent(record, matchResult, matchResult.mismatch ? 'catastrophic_mismatch_blocked' : 'verified_and_cleared');
    return { dashboardPayload, alarmTicket, splunkEvent };
  }
}

module.exports = {
  SpecimenMismatchGuard,
  SPECIMEN_ALLOWLIST,
};
