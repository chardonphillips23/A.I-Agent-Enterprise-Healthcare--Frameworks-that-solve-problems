'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const VITALS_ALLOWLIST = ['heartRate', 'respirationRate', 'temperatureCelsius', 'capillaryRefillTimeSeconds'];

function hashSubjectId(horseId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${horseId}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

// Normal adult horse ranges: HR 28-44 bpm, RR 8-16/min, Temp 37.2-38.3°C,
// CRT < 2s. Heart rate >60 bpm and CRT >2s are the two most sensitive
// single indicators of a colic/shock crisis, so each is weighted heavily
// enough to cross the critical threshold on its own.
function scoreHeartRate(hr) {
  if (hr <= 44) return 0;
  if (hr <= 60) return 2;
  return 5;
}

function scoreRespiration(rr) {
  if (rr <= 16) return 0;
  if (rr <= 24) return 1;
  if (rr <= 30) return 2;
  return 3;
}

function scoreTemperature(tempC) {
  if (tempC < 37) return 1;
  if (tempC <= 38.5) return 0;
  if (tempC <= 39.5) return 1;
  return 2;
}

function scoreCapillaryRefill(crtSeconds) {
  if (crtSeconds <= 2) return 0;
  return 5;
}

class EquineTelemetryMews {
  // Stage 1 (Telemetry Ingestion): the raw horseId is only used here to
  // derive a hashed subjectId; only the four vitals survive into the record.
  ingest(rawTelemetry) {
    if (!rawTelemetry || typeof rawTelemetry !== 'object') {
      throw new TypeError('rawTelemetry must be an object');
    }
    const { horseId, heartRate, respirationRate, temperatureCelsius, capillaryRefillTime } = rawTelemetry;
    if (!horseId) {
      throw new Error('rawTelemetry requires horseId to derive a subjectId');
    }
    if ([heartRate, respirationRate, temperatureCelsius, capillaryRefillTime].some((v) => v == null)) {
      throw new Error('rawTelemetry requires heartRate, respirationRate, temperatureCelsius, and capillaryRefillTime');
    }

    const record = {
      subjectId: hashSubjectId(horseId),
      heartRate: Number(heartRate),
      respirationRate: Number(respirationRate),
      temperatureCelsius: Number(temperatureCelsius),
      capillaryRefillTimeSeconds: Number(capillaryRefillTime),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !VITALS_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & EEWS Scoring): defense-in-depth guard, then sum
  // the four subscores. A total of 5 or more is a critical colic-crisis risk.
  computeEews(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !VITALS_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached scoring stage`);
    }

    const subscores = {
      heartRateScore: scoreHeartRate(record.heartRate),
      respirationScore: scoreRespiration(record.respirationRate),
      temperatureScore: scoreTemperature(record.temperatureCelsius),
      capillaryRefillScore: scoreCapillaryRefill(record.capillaryRefillTimeSeconds),
    };
    const eewsScore = Object.values(subscores).reduce((sum, n) => sum + n, 0);

    return { eewsScore, criticalRisk: eewsScore >= 5, subscores };
  }

  // Stage 3 (Integration): PIMS patient dashboard vitals update — runs on
  // every reading, since the dashboard reflects continuous stall monitoring.
  buildDashboardVitalsUpdate(record, eewsResult) {
    return `PIMS-VITALS|${record.subjectId}|HR:${record.heartRate}bpm|RR:${record.respirationRate}/min|TEMP:${record.temperatureCelsius}C|CRT:${record.capillaryRefillTimeSeconds}s|EEWS:${eewsResult.eewsScore}|STATUS:${eewsResult.criticalRisk ? 'CRITICAL' : 'STABLE'}`;
  }

  // Stage 4a (Field Surgeon Broadcast): only built when EEWS >= 5.
  buildFieldSurgeonBroadcast(record, eewsResult) {
    return {
      channel: 'large_animal_field_surgeon_sms',
      priority: 'immediate',
      subjectId: record.subjectId,
      headline: `EEWS ${eewsResult.eewsScore} — possible colic crisis, immediate evaluation required`,
      vitalsSummary: `HR ${record.heartRate}bpm, RR ${record.respirationRate}/min, Temp ${record.temperatureCelsius}C, CRT ${record.capillaryRefillTimeSeconds}s`,
      requestedAction: 'Dispatch on-call large-animal field surgeon to the stall immediately; prepare for potential colic workup/surgical consult.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk SIEM log on every reading.
  buildSplunkEvent(record, eewsResult, surgeonBroadcast) {
    return {
      time: Date.now() / 1000,
      host: 'equine-telemetry-mews',
      source: 'hub4_veterinary_operations/equine_telemetry_mews',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: surgeonBroadcast ? 'critical_field_surgeon_paged' : 'routine_monitoring',
        eewsScore: eewsResult.eewsScore,
        criticalRisk: eewsResult.criticalRisk,
        maskedVitals: {
          heartRate: maskValue(record.heartRate),
          respirationRate: maskValue(record.respirationRate),
          temperatureCelsius: maskValue(record.temperatureCelsius),
          capillaryRefillTimeSeconds: maskValue(record.capillaryRefillTimeSeconds),
        },
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawTelemetry) {
    const record = this.ingest(rawTelemetry);
    const eewsResult = this.computeEews(record);
    const dashboardUpdate = this.buildDashboardVitalsUpdate(record, eewsResult);
    const surgeonBroadcast = eewsResult.criticalRisk ? this.buildFieldSurgeonBroadcast(record, eewsResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, eewsResult, surgeonBroadcast);
    return { dashboardUpdate, surgeonBroadcast, splunkEvent, eewsScore: eewsResult.eewsScore, criticalRisk: eewsResult.criticalRisk };
  }
}

module.exports = {
  EquineTelemetryMews,
  VITALS_ALLOWLIST,
};
