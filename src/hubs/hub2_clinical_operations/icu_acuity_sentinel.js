'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const VITALS_ALLOWLIST = ['respirationRate', 'heartRate', 'systolicBP', 'temperatureCelsius'];

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

function scoreRespiration(rr) {
  if (rr <= 8) return 3;
  if (rr <= 14) return 0;
  if (rr <= 20) return 1;
  if (rr <= 29) return 2;
  return 3;
}

function scoreHeartRate(hr) {
  if (hr <= 40) return 2;
  if (hr <= 50) return 1;
  if (hr <= 100) return 0;
  if (hr <= 110) return 1;
  if (hr <= 129) return 2;
  return 3;
}

function scoreSystolicBP(sbp) {
  if (sbp <= 70) return 3;
  if (sbp <= 80) return 2;
  if (sbp <= 100) return 1;
  if (sbp <= 199) return 0;
  return 2;
}

function scoreTemperature(tempC) {
  if (tempC < 35) return 2;
  if (tempC < 38.5) return 0;
  return 2;
}

class IcuAcuitySentinel {
  // Stage 1 (Vitals Ingestion): retain only the four MEWS input vitals plus
  // a one-way pseudonymous subject ID. Any raw text/object fields not on
  // the allowlist are dropped before the record leaves this function.
  ingest(rawVitals) {
    if (!rawVitals || typeof rawVitals !== 'object') {
      throw new TypeError('rawVitals must be an object');
    }
    const { mrn, dob, respirationRate, heartRate, systolicBP, temperatureCelsius } = rawVitals;
    if (!mrn || !dob) {
      throw new Error('rawVitals requires mrn and dob to derive a subjectId');
    }
    if ([respirationRate, heartRate, systolicBP, temperatureCelsius].some((v) => v == null)) {
      throw new Error('rawVitals requires respirationRate, heartRate, systolicBP, and temperatureCelsius');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      respirationRate: Number(respirationRate),
      heartRate: Number(heartRate),
      systolicBP: Number(systolicBP),
      temperatureCelsius: Number(temperatureCelsius),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !VITALS_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & MEWS Scoring): defense-in-depth guard, then sum
  // the four MEWS subscores. A total of 5 or more is a critical risk.
  computeMews(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !VITALS_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached scoring stage`);
    }

    const subscores = {
      respirationScore: scoreRespiration(record.respirationRate),
      heartRateScore: scoreHeartRate(record.heartRate),
      systolicBPScore: scoreSystolicBP(record.systolicBP),
      temperatureScore: scoreTemperature(record.temperatureCelsius),
    };
    const mewsScore = Object.values(subscores).reduce((sum, n) => sum + n, 0);

    return { mewsScore, criticalRisk: mewsScore >= 5, subscores };
  }

  // Stage 3 (Integration): shape an HL7 v2 ORU^R01 telemetry message —
  // this runs on every reading, since continuous vitals monitoring feeds
  // are sent regardless of risk level.
  buildHl7OruMessage(record, mewsResult) {
    const now = new Date();
    const hl7Timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const messageId = `MSG${now.getTime()}`;

    const segments = [
      `MSH|^~\\&|ICU_ACUITY_SENTINEL|HOSPITAL|CLINICAL_MONITORING|HOSPITAL|${hl7Timestamp}||ORU^R01|${messageId}|P|2.5`,
      `PID|1||${record.subjectId}`,
      'OBR|1|||MEWS^Modified Early Warning Score',
      `OBX|1|NM|9279-1^Respiratory Rate||${record.respirationRate}|/min|||||F`,
      `OBX|2|NM|8867-4^Heart Rate||${record.heartRate}|/min|||||F`,
      `OBX|3|NM|8480-6^Systolic Blood Pressure||${record.systolicBP}|mm[Hg]|||||F`,
      `OBX|4|NM|8310-5^Body Temperature||${record.temperatureCelsius}|Cel|||||F`,
      `OBX|5|NM|MEWS^MEWS Total Score||${mewsResult.mewsScore}||||||${mewsResult.criticalRisk ? 'A' : 'F'}`,
    ];

    return segments.join('\r');
  }

  // Stage 4a (Clinical Sentinel Intercept): only built when MEWS >= 5.
  buildPagerAlert(record, mewsResult) {
    return {
      channel: 'physician_pager',
      priority: 'stat',
      subjectId: record.subjectId,
      headline: `STAT: MEWS score ${mewsResult.mewsScore} — critical deterioration risk`,
      vitalsSummary: `RR ${record.respirationRate}, HR ${record.heartRate}, SBP ${record.systolicBP}, Temp ${record.temperatureCelsius}°C`,
      requestedAction: 'Bedside physician assessment required immediately.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): Splunk HEC event on every reading; vitals
  // are masked so the log carries no plaintext physiological readings.
  buildSplunkEvent(record, mewsResult, pagerAlert) {
    return {
      time: Date.now() / 1000,
      host: 'icu-acuity-sentinel',
      source: 'hub2_clinical_operations/icu_acuity_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: pagerAlert ? 'critical_pager_triggered' : 'routine_monitoring',
        mewsScore: mewsResult.mewsScore,
        criticalRisk: mewsResult.criticalRisk,
        maskedVitals: {
          respirationRate: maskValue(record.respirationRate),
          heartRate: maskValue(record.heartRate),
          systolicBP: maskValue(record.systolicBP),
          temperatureCelsius: maskValue(record.temperatureCelsius),
        },
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawVitals) {
    const record = this.ingest(rawVitals);
    const mewsResult = this.computeMews(record);
    const hl7Message = this.buildHl7OruMessage(record, mewsResult);
    const pagerAlert = mewsResult.criticalRisk ? this.buildPagerAlert(record, mewsResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, mewsResult, pagerAlert);
    return { hl7Message, pagerAlert, splunkEvent, mewsScore: mewsResult.mewsScore, criticalRisk: mewsResult.criticalRisk };
  }
}

module.exports = {
  IcuAcuitySentinel,
  VITALS_ALLOWLIST,
};
