'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const PILLBOX_ALLOWLIST = ['compartmentLabel', 'openEventTimestamps'];

const NON_ADHERENCE_WINDOW_HOURS = 48;

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

class SmartPillboxAdherenceAuditor {
  // Stage 1 (Pillbox Event Ingestion): mrn/dob are only used to derive a
  // hashed subjectId; the compartment label and lid-opening timestamps
  // survive into the record.
  ingest(rawPillboxData, patientIdentifiers) {
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }
    const { compartmentLabel, openEventTimestamps } = rawPillboxData || {};
    if (!compartmentLabel) {
      throw new Error('rawPillboxData requires compartmentLabel');
    }
    if (!Array.isArray(openEventTimestamps)) {
      throw new Error('rawPillboxData requires openEventTimestamps to be an array');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      compartmentLabel,
      openEventTimestamps: openEventTimestamps.map(String),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !PILLBOX_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Adherence Rules): defense-in-depth guard, then
  // flag critical non-adherence if the most recent lid opening is more
  // than 48 hours old (or there are no recorded openings at all).
  evaluateAdherence(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !PILLBOX_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached adherence evaluation stage`);
    }

    const timestamps = record.openEventTimestamps.map((t) => new Date(t)).filter((d) => !Number.isNaN(d.getTime()));
    const mostRecentOpen = timestamps.length > 0 ? new Date(Math.max(...timestamps.map((d) => d.getTime()))) : null;
    const hoursSinceLastOpen = mostRecentOpen ? (Date.now() - mostRecentOpen.getTime()) / (1000 * 60 * 60) : Infinity;
    const criticalRisk = hoursSinceLastOpen > NON_ADHERENCE_WINDOW_HOURS;

    return { criticalRisk, hoursSinceLastOpen, status: criticalRisk ? 'CRITICAL_MEDICATION_NON_ADHERENCE' : 'ADHERENT' };
  }

  // Stage 3 (Integration): only reachable on critical non-adherence.
  buildPharmacyOutreachTask(record, adherenceResult) {
    const hoursDisplay = Number.isFinite(adherenceResult.hoursSinceLastOpen) ? adherenceResult.hoursSinceLastOpen.toFixed(1) : 'NEVER_OPENED';
    return `PHARMACY-OUTREACH-TASK|${record.subjectId}|COMPARTMENT:${record.compartmentLabel}|HOURS_SINCE_LAST_OPEN:${hoursDisplay}|ACTION:PROACTIVE_TELEPHONIC_CHECK_IN|PRIORITY:HIGH|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): secure Splunk HEC compliance record
  // carrying the anonymized tracking fingerprint — the compartment label
  // (which may itself name the medication) is masked before logging.
  buildSplunkEvent(record, adherenceResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'smart-pillbox-adherence-auditor',
      source: 'hub6_edge_telemetry/smart_pillbox_adherence_auditor',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: adherenceResult.criticalRisk,
        status: adherenceResult.status,
        hoursSinceLastOpen: Number.isFinite(adherenceResult.hoursSinceLastOpen) ? Number(adherenceResult.hoursSinceLastOpen.toFixed(1)) : null,
        maskedCompartmentLabel: maskValue(record.compartmentLabel),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawPillboxData, patientIdentifiers) {
    const record = this.ingest(rawPillboxData, patientIdentifiers);
    const adherenceResult = this.evaluateAdherence(record);
    const outreachTask = adherenceResult.criticalRisk ? this.buildPharmacyOutreachTask(record, adherenceResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, adherenceResult, outreachTask ? 'critical_non_adherence_escalated' : 'adherent');
    return { outreachTask, status: adherenceResult.status, splunkEvent };
  }
}

module.exports = {
  SmartPillboxAdherenceAuditor,
  NON_ADHERENCE_WINDOW_HOURS,
  PILLBOX_ALLOWLIST,
};
