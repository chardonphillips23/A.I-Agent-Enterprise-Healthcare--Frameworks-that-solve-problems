'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const TELEMETRY_ALLOWLIST = ['heartRate', 'rhythmStatus'];

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

class CardiacArrhythmiaDetector {
  // Stage 1 (Wearable Telemetry Ingestion): mrn/dob are only used to
  // derive a hashed subjectId; only heartRate and rhythmStatus survive.
  ingest(rawTelemetry) {
    if (!rawTelemetry || typeof rawTelemetry !== 'object') {
      throw new TypeError('rawTelemetry must be an object');
    }
    const { mrn, dob, heartRate, rhythmStatus } = rawTelemetry;
    if (!mrn || !dob) {
      throw new Error('rawTelemetry requires mrn and dob to derive a subjectId');
    }
    if (heartRate == null || !rhythmStatus) {
      throw new Error('rawTelemetry requires heartRate and rhythmStatus');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      heartRate: Number(heartRate),
      rhythmStatus,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !TELEMETRY_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Cardiac Stability Rules): defense-in-depth
  // guard, then flag ventricular tachycardia when heart rate exceeds
  // 160bpm on an unstable rhythm.
  evaluateCardiacStability(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !TELEMETRY_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached stability evaluation stage`);
    }

    const criticalRisk = record.heartRate > 160 && record.rhythmStatus === 'unstable';
    return { criticalRisk, telemetryStatus: criticalRisk ? 'VENTRICULAR_TACHYCARDIA' : 'STABLE' };
  }

  // Stage 3 (Integration): HL7 v2 ORU^R01 cardiology telemetry alert —
  // runs on every reading, since telemetry is streamed continuously.
  buildOruTelemetryAlert(record, stabilityResult) {
    const now = new Date();
    const hl7Timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const messageId = `MSG${now.getTime()}`;
    const observationStatus = stabilityResult.criticalRisk ? 'A' : 'F';

    const segments = [
      `MSH|^~\\&|CARDIAC_ARRHYTHMIA_DETECTOR|WEARABLE|CARDIOLOGY_MONITORING|HOSPITAL|${hl7Timestamp}||ORU^R01|${messageId}|P|2.5`,
      `PID|1||${record.subjectId}`,
      'OBR|1|||CARDIAC_TELEMETRY^Cardiac Rhythm Telemetry',
      `OBX|1|NM|8867-4^Heart Rate||${record.heartRate}|/min|||||${observationStatus}`,
      `OBX|2|ST|RHYTHM^Rhythm Status||${record.rhythmStatus}||||||${observationStatus}`,
      `OBX|3|ST|STATUS^Telemetry Status||${stabilityResult.telemetryStatus}||||||${observationStatus}`,
    ];

    return segments.join('\r');
  }

  // Stage 4a (Cardiologist Sentinel Intercept): only built on critical risk.
  buildCardiologistPagerAlert(record) {
    return {
      channel: 'emergency_cardiologist_pager',
      priority: 'stat',
      subjectId: record.subjectId,
      headline: `STAT: Ventricular tachycardia suspected — HR ${record.heartRate}bpm, rhythm ${record.rhythmStatus}`,
      requestedAction: 'Immediate cardiologist evaluation required; prepare for potential emergency intervention.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk event on every reading.
  buildSplunkEvent(record, stabilityResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'cardiac-arrhythmia-detector',
      source: 'hub6_edge_telemetry/cardiac_arrhythmia_detector',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: stabilityResult.criticalRisk,
        telemetryStatus: stabilityResult.telemetryStatus,
        maskedHeartRate: maskValue(record.heartRate),
        maskedRhythmStatus: maskValue(record.rhythmStatus),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawTelemetry) {
    const record = this.ingest(rawTelemetry);
    const stabilityResult = this.evaluateCardiacStability(record);
    const oruMessage = this.buildOruTelemetryAlert(record, stabilityResult);
    const pagerAlert = stabilityResult.criticalRisk ? this.buildCardiologistPagerAlert(record) : null;
    const splunkEvent = this.buildSplunkEvent(record, stabilityResult, pagerAlert ? 'critical_cardiologist_paged' : 'routine_monitoring');
    return { oruMessage, pagerAlert, splunkEvent, telemetryStatus: stabilityResult.telemetryStatus, criticalRisk: stabilityResult.criticalRisk };
  }
}

module.exports = {
  CardiacArrhythmiaDetector,
  TELEMETRY_ALLOWLIST,
};
