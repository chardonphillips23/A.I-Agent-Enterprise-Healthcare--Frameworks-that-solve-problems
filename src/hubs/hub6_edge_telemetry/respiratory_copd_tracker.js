'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const OXIMETER_ALLOWLIST = ['historicalSpO2'];

const TREND_WINDOW_HOURS = 72;
const CHRONIC_DISTRESS_SPO2_THRESHOLD = 88;

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class RespiratoryCopdTracker {
  // Stage 1 (Oximeter History Ingestion): mrn/dob are only used to derive
  // a hashed subjectId; only the rolling SpO2 history survives.
  ingest(rawHistory) {
    if (!rawHistory || typeof rawHistory !== 'object') {
      throw new TypeError('rawHistory must be an object');
    }
    const { mrn, dob, historicalSpO2 } = rawHistory;
    if (!mrn || !dob) {
      throw new Error('rawHistory requires mrn and dob to derive a subjectId');
    }
    if (!Array.isArray(historicalSpO2) || historicalSpO2.length === 0) {
      throw new Error('rawHistory requires a non-empty historicalSpO2 array');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      historicalSpO2: historicalSpO2.map(Number),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !OXIMETER_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & 3-Day Trend Analysis): defense-in-depth guard,
  // then flag chronic distress only if a full 72-hour (hourly-sampled)
  // window is available and every reading in it stays below 88%.
  evaluateTrend(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !OXIMETER_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached trend evaluation stage`);
    }

    const recentWindow = record.historicalSpO2.slice(-TREND_WINDOW_HOURS);
    const sufficientData = recentWindow.length >= TREND_WINDOW_HOURS;
    const allBelowThreshold = sufficientData && recentWindow.every((reading) => reading < CHRONIC_DISTRESS_SPO2_THRESHOLD);
    const averageSpO2 = recentWindow.reduce((sum, reading) => sum + reading, 0) / recentWindow.length;

    return { criticalRisk: allBelowThreshold, sufficientData, averageSpO2, status: allBelowThreshold ? 'CHRONIC_RESPIRATORY_DISTRESS' : 'STABLE' };
  }

  // Stage 3 (Integration): only reachable on a confirmed chronic-distress
  // trend. Books a preventive home-health telehealth nurse appointment.
  buildTelehealthBookingPayload(record, trendResult) {
    return `TELEHEALTH-BOOKING|${record.subjectId}|APPOINTMENT_TYPE:HOME_HEALTH_NURSE_PREVENTIVE|REASON:CHRONIC_RESPIRATORY_DISTRESS|AVG_SPO2:${trendResult.averageSpO2.toFixed(1)}|REQUESTED_WINDOW:NEXT_24_HOURS|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): masked Splunk HEC event carrying only the
  // trend summary, never the raw 72-reading history.
  buildSplunkEvent(record, trendResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'respiratory-copd-tracker',
      source: 'hub6_edge_telemetry/respiratory_copd_tracker',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: trendResult.criticalRisk,
        status: trendResult.status,
        averageSpO2: Number(trendResult.averageSpO2.toFixed(1)),
        sufficientData: trendResult.sufficientData,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawHistory) {
    const record = this.ingest(rawHistory);
    const trendResult = this.evaluateTrend(record);
    const bookingPayload = trendResult.criticalRisk ? this.buildTelehealthBookingPayload(record, trendResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, trendResult, bookingPayload ? 'chronic_distress_booking_triggered' : 'stable_trend');
    return { bookingPayload, status: trendResult.status, splunkEvent };
  }
}

module.exports = {
  RespiratoryCopdTracker,
  TREND_WINDOW_HOURS,
  CHRONIC_DISTRESS_SPO2_THRESHOLD,
  OXIMETER_ALLOWLIST,
};
