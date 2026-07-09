'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const TELEMETRY_ALLOWLIST = ['productName', 'temperatureCelsius', 'readingTimestamp', 'recommendedBackupUnit'];

const FIELD_PATTERNS = {
  unitId: /unit:\s*([^\n]+)/i,
  productName: /product:\s*([^\n]+)/i,
  temperature: /temperature:\s*(-?\d+(?:\.\d+)?)\s*c/i,
  timestamp: /timestamp:\s*([^\n]+)/i,
};

const ADJACENT_UNIT_REGISTRY = {
  'FRIDGE-7': 'FRIDGE-8',
  'FRIDGE-3': 'FRIDGE-4',
};

function hashAssetId(unitId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${unitId}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

function extractField(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

class ColdChainIotSentinel {
  // Stage 1 (Telemetry Ingestion): the raw unit ID is only used here to
  // derive a hashed assetId and to look up the adjacent backup unit; the
  // raw telemetry string itself is discarded after extraction.
  ingest(telemetryText) {
    if (typeof telemetryText !== 'string' || !telemetryText.trim()) {
      throw new TypeError('telemetryText must be a non-empty string');
    }

    const unitIdRaw = extractField(telemetryText, FIELD_PATTERNS.unitId);
    if (!unitIdRaw) {
      throw new Error('telemetryText requires a Unit identifier');
    }
    const temperatureMatch = telemetryText.match(FIELD_PATTERNS.temperature);
    if (!temperatureMatch) {
      throw new Error('telemetryText requires a Temperature reading in Celsius');
    }

    const record = {
      assetId: hashAssetId(unitIdRaw),
      productName: extractField(telemetryText, FIELD_PATTERNS.productName) || 'unspecified',
      temperatureCelsius: parseFloat(temperatureMatch[1]),
      readingTimestamp: extractField(telemetryText, FIELD_PATTERNS.timestamp) || new Date().toISOString(),
      recommendedBackupUnit: ADJACENT_UNIT_REGISTRY[unitIdRaw] || 'CENTRAL_COLD_STORAGE_BACKUP',
    };

    for (const key of Object.keys(record)) {
      if (key !== 'assetId' && !TELEMETRY_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Cold-Chain Rules): defense-in-depth guard, then
  // check the reading against the strict 2°C-8°C safe storage window.
  evaluateColdChain(record) {
    const leaked = Object.keys(record).find((key) => key !== 'assetId' && !TELEMETRY_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached evaluation stage`);
    }

    const withinRange = record.temperatureCelsius >= 2 && record.temperatureCelsius <= 8;
    const spoilageIncident = !withinRange;
    const severity = spoilageIncident ? (record.temperatureCelsius > 8 ? 'warming_excursion' : 'freezing_excursion') : null;

    return { withinRange, spoilageIncident, severity };
  }

  // Stage 3 (Integration): only reachable on a spoilage incident. Shapes a
  // supply-chain redistribution ticket to move stock to the backup unit.
  buildRedistributionPayload(record, coldChainResult) {
    return {
      ticketType: 'cold_chain_redistribution',
      assetId: record.assetId,
      productName: record.productName,
      severity: coldChainResult.severity,
      transferTo: record.recommendedBackupUnit,
      temperatureAtIncident: record.temperatureCelsius,
      requestedAt: new Date().toISOString(),
    };
  }

  // Stage 4a (Facilities Intercept): only reachable on a spoilage incident.
  buildFacilitiesTicket(record, coldChainResult) {
    return {
      channel: 'facilities_emergency_queue',
      priority: 'urgent_work_order',
      assetId: record.assetId,
      headline: `Cold chain excursion detected — ${coldChainResult.severity}`,
      detail: `Recorded ${record.temperatureCelsius}°C, outside the 2-8°C safe storage range for ${record.productName}.`,
      requestedAction: 'Dispatch facilities engineering immediately; confirm product transfer to the backup unit and inspect the refrigeration unit.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): Splunk HEC event on every reading, with
  // the product name masked before it reaches the log.
  buildSplunkEvent(record, coldChainResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'cold-chain-iot-sentinel',
      source: 'hub3_pharmacy_logistics/cold_chain_iot_sentinel',
      sourcetype: '_json',
      event: {
        assetId: record.assetId,
        action: outcome,
        withinRange: coldChainResult.withinRange,
        severity: coldChainResult.severity,
        temperatureCelsius: record.temperatureCelsius,
        productName: maskValue(record.productName),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(telemetryText) {
    const record = this.ingest(telemetryText);
    const coldChainResult = this.evaluateColdChain(record);

    if (coldChainResult.spoilageIncident) {
      const redistributionPayload = this.buildRedistributionPayload(record, coldChainResult);
      const facilitiesTicket = this.buildFacilitiesTicket(record, coldChainResult);
      const splunkEvent = this.buildSplunkEvent(record, coldChainResult, 'spoilage_incident_escalated');
      return { redistributionPayload, facilitiesTicket, splunkEvent };
    }

    const splunkEvent = this.buildSplunkEvent(record, coldChainResult, 'within_safe_range');
    return { redistributionPayload: null, facilitiesTicket: null, splunkEvent };
  }
}

module.exports = {
  ColdChainIotSentinel,
  ADJACENT_UNIT_REGISTRY,
  TELEMETRY_ALLOWLIST,
};
