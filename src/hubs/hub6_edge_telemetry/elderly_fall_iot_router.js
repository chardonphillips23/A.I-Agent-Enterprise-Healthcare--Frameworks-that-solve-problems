'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const ACCELEROMETER_ALLOWLIST = ['gForceValue', 'noMotionDurationSeconds', 'latitude', 'longitude'];

const FALL_G_FORCE_THRESHOLD = 4.5;
const FALL_NO_MOTION_THRESHOLD_SECONDS = 60;

function hashTrackingId(deviceId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${deviceId}`)
    .digest('hex');
}

class ElderlyFallIotRouter {
  // Stage 1 (Accelerometer Ingestion): the raw deviceId is only used to
  // derive a hashed trackingId; g-force, motion duration, and location
  // survive — location is needed verbatim for Stage 3's EMS dispatch.
  ingest(rawAccelerometerData) {
    if (!rawAccelerometerData || typeof rawAccelerometerData !== 'object') {
      throw new TypeError('rawAccelerometerData must be an object');
    }
    const { deviceId, gForceValue, noMotionDurationSeconds, latitude, longitude } = rawAccelerometerData;
    if (!deviceId) {
      throw new Error('rawAccelerometerData requires deviceId to derive a trackingId');
    }
    if (gForceValue == null || noMotionDurationSeconds == null) {
      throw new Error('rawAccelerometerData requires gForceValue and noMotionDurationSeconds');
    }

    const record = {
      trackingId: hashTrackingId(deviceId),
      gForceValue: Number(gForceValue),
      noMotionDurationSeconds: Number(noMotionDurationSeconds),
      latitude: latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'trackingId' && !ACCELEROMETER_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Fall Detection Rules): defense-in-depth guard,
  // then flag a fall when a hard impact is followed by sustained stillness.
  detectFall(record) {
    const leaked = Object.keys(record).find((key) => key !== 'trackingId' && !ACCELEROMETER_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached detection stage`);
    }

    const criticalRisk = record.gForceValue >= FALL_G_FORCE_THRESHOLD && record.noMotionDurationSeconds >= FALL_NO_MOTION_THRESHOLD_SECONDS;
    return { criticalRisk, status: criticalRisk ? 'ELDERLY_FALL_DETECTED' : 'NO_FALL_DETECTED' };
  }

  // Stage 3 (Integration): only reachable on a detected fall. Exact
  // coordinates are required here — EMS cannot dispatch without them.
  buildEmsDispatchTicket(record, fallResult) {
    return `EMS-DISPATCH-TICKET|TRACKING_ID:${record.trackingId}|STATUS:${fallResult.status}|G_FORCE:${record.gForceValue}|NO_MOTION_SEC:${record.noMotionDurationSeconds}|LAT:${record.latitude}|LON:${record.longitude}|DISPATCH_PRIORITY:IMMEDIATE|CREATED_AT:${new Date().toISOString()}`;
  }

  // Stage 4 (Audit Telemetry): tokenized Splunk record on every reading —
  // coordinates are reduced to ~11km precision rather than logged raw, so
  // the SIEM audit trail never carries an exact address-level location.
  buildSplunkEvent(record, fallResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'elderly-fall-iot-router',
      source: 'hub6_edge_telemetry/elderly_fall_iot_router',
      sourcetype: '_json',
      event: {
        trackingId: record.trackingId,
        action: outcome,
        criticalRisk: fallResult.criticalRisk,
        gForceValue: record.gForceValue,
        noMotionDurationSeconds: record.noMotionDurationSeconds,
        approximateLatitude: record.latitude != null ? Math.round(record.latitude * 10) / 10 : null,
        approximateLongitude: record.longitude != null ? Math.round(record.longitude * 10) / 10 : null,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawAccelerometerData) {
    const record = this.ingest(rawAccelerometerData);
    const fallResult = this.detectFall(record);
    const emsDispatchTicket = fallResult.criticalRisk ? this.buildEmsDispatchTicket(record, fallResult) : null;
    const splunkEvent = this.buildSplunkEvent(record, fallResult, emsDispatchTicket ? 'ems_dispatched' : 'no_fall_detected');
    return { emsDispatchTicket, status: fallResult.status, splunkEvent };
  }
}

module.exports = {
  ElderlyFallIotRouter,
  FALL_G_FORCE_THRESHOLD,
  FALL_NO_MOTION_THRESHOLD_SECONDS,
  ACCELEROMETER_ALLOWLIST,
};
