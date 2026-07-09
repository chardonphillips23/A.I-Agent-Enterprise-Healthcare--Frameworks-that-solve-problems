'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const SENSOR_ALLOWLIST = ['ppmValue', 'sustainedMinutesAboveThreshold'];

const NITROUS_PPM_THRESHOLD = 25;
const NITROUS_SUSTAINED_MINUTES_THRESHOLD = 5;

function hashAssetId(sensorId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${sensorId}`)
    .digest('hex');
}

class NitrousOxideSafetySentinel {
  // Stage 1 (Environmental Sensor Ingestion): the raw sensorId is only
  // used to derive a hashed assetId; only the ppm reading and sustained
  // duration survive into the record.
  ingest(rawSensorData) {
    if (!rawSensorData || typeof rawSensorData !== 'object') {
      throw new TypeError('rawSensorData must be an object');
    }
    const { sensorId, ppmValue, sustainedMinutesAboveThreshold } = rawSensorData;
    if (!sensorId) {
      throw new Error('rawSensorData requires sensorId to derive an assetId');
    }
    if (ppmValue == null || sustainedMinutesAboveThreshold == null) {
      throw new Error('rawSensorData requires ppmValue and sustainedMinutesAboveThreshold');
    }

    const record = {
      assetId: hashAssetId(sensorId),
      ppmValue: Number(ppmValue),
      sustainedMinutesAboveThreshold: Number(sustainedMinutesAboveThreshold),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'assetId' && !SENSOR_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Environmental Safety Rules): defense-in-depth guard, then
  // flag a hazardous leak only when the concentration exceeds the safe
  // threshold continuously for more than 5 minutes.
  evaluateGasSafety(record) {
    const leaked = Object.keys(record).find((key) => key !== 'assetId' && !SENSOR_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached gas safety evaluation stage`);
    }

    const hazardousLeak = record.ppmValue > NITROUS_PPM_THRESHOLD && record.sustainedMinutesAboveThreshold > NITROUS_SUSTAINED_MINUTES_THRESHOLD;
    return { hazardousLeak, status: hazardousLeak ? 'HAZARDOUS_NITROUS_LEAK' : 'SAFE' };
  }

  // Stage 3 (Integration): only reachable on a hazardous leak. A
  // fail-safe command directed at the manifold gas lines.
  buildManifoldShutdownCommand(record, safetyResult) {
    return `MANIFOLD-SHUTDOWN-COMMAND|${record.assetId}|STATUS:${safetyResult.status}|PPM:${record.ppmValue}|SUSTAINED_MIN:${record.sustainedMinutesAboveThreshold}|ACTION:FAIL_SAFE_GAS_LINE_SHUTOFF|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4a (Facilities Intercept): only reachable on a hazardous leak.
  buildFacilitiesAlarmTicket(record, safetyResult) {
    return {
      channel: 'facilities_environmental_alarm',
      priority: 'critical_hazard',
      assetId: record.assetId,
      headline: `HAZARDOUS NITROUS OXIDE LEAK: ${record.ppmValue}ppm sustained for ${record.sustainedMinutesAboveThreshold} minutes`,
      requestedAction: 'Evacuate the surgical suite immediately, confirm manifold shutoff engaged, and ventilate the space before re-entry.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): structured Splunk HEC compliance log on
  // every reading. No patient identifiers are involved in this agent —
  // ppmValue and assetId are equipment/environmental telemetry, not PHI.
  buildSplunkEvent(record, safetyResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'nitrous-oxide-safety-sentinel',
      source: 'hub7_dental_operations/nitrous_oxide_safety_sentinel',
      sourcetype: '_json',
      event: {
        assetId: record.assetId,
        action: outcome,
        hazardousLeak: safetyResult.hazardousLeak,
        ppmValue: record.ppmValue,
        sustainedMinutesAboveThreshold: record.sustainedMinutesAboveThreshold,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawSensorData) {
    const record = this.ingest(rawSensorData);
    const safetyResult = this.evaluateGasSafety(record);

    if (safetyResult.hazardousLeak) {
      const shutdownCommand = this.buildManifoldShutdownCommand(record, safetyResult);
      const alarmTicket = this.buildFacilitiesAlarmTicket(record, safetyResult);
      const splunkEvent = this.buildSplunkEvent(record, safetyResult, 'hazardous_leak_shutdown_triggered');
      return { shutdownCommand, alarmTicket, splunkEvent };
    }

    const splunkEvent = this.buildSplunkEvent(record, safetyResult, 'safe_levels');
    return { shutdownCommand: null, alarmTicket: null, splunkEvent };
  }
}

module.exports = {
  NitrousOxideSafetySentinel,
  NITROUS_PPM_THRESHOLD,
  NITROUS_SUSTAINED_MINUTES_THRESHOLD,
  SENSOR_ALLOWLIST,
};
