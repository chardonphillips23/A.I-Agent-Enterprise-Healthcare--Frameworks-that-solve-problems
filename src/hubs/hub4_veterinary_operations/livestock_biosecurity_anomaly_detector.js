'use strict';

const METRICS_ALLOWLIST = [
  'sectorCode',
  'species',
  'flockCount',
  'previousDayMortality',
  'currentDayMortality',
  'previousDayWaterConsumptionLiters',
  'currentDayWaterConsumptionLiters',
  'feedConsumptionKg',
];

const MORTALITY_SPIKE_THRESHOLD_PERCENT = 300;
const WATER_DROP_THRESHOLD_PERCENT = -30;

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class LivestockBiosecurityAnomalyDetector {
  // Stage 1 (Production Metrics Ingestion): unlike patient-facing agents,
  // sectorCode is retained verbatim rather than hashed — a real USDA/state
  // outbreak notification (Stage 3) is useless without the actual
  // geographic location, so there is no direct patient identifier to
  // pseudonymize here in the first place.
  ingest(rawMetrics) {
    if (!rawMetrics || typeof rawMetrics !== 'object') {
      throw new TypeError('rawMetrics must be an object');
    }
    const {
      sectorCode,
      species,
      flockCount,
      previousDayMortality,
      currentDayMortality,
      previousDayWaterConsumptionLiters,
      currentDayWaterConsumptionLiters,
      feedConsumptionKg,
    } = rawMetrics;

    if (!sectorCode || !species) {
      throw new Error('rawMetrics requires sectorCode and species');
    }
    if (
      [
        flockCount,
        previousDayMortality,
        currentDayMortality,
        previousDayWaterConsumptionLiters,
        currentDayWaterConsumptionLiters,
        feedConsumptionKg,
      ].some((v) => v == null)
    ) {
      throw new Error(
        'rawMetrics requires flockCount, previousDayMortality, currentDayMortality, previousDayWaterConsumptionLiters, currentDayWaterConsumptionLiters, and feedConsumptionKg'
      );
    }

    const record = {
      sectorCode,
      species,
      flockCount: Number(flockCount),
      previousDayMortality: Number(previousDayMortality),
      currentDayMortality: Number(currentDayMortality),
      previousDayWaterConsumptionLiters: Number(previousDayWaterConsumptionLiters),
      currentDayWaterConsumptionLiters: Number(currentDayWaterConsumptionLiters),
      feedConsumptionKg: Number(feedConsumptionKg),
    };

    for (const key of Object.keys(record)) {
      if (!METRICS_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Statistical Anomaly Detection): defense-in-depth guard, then
  // flag a mortality spike (>300% in 24h) or a sharp water-consumption
  // drop (>=30% in 24h) as a biosecurity outbreak signal.
  detectAnomaly(record) {
    const leaked = Object.keys(record).find((key) => !METRICS_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached anomaly detection stage`);
    }

    const mortalityChangePercent =
      record.previousDayMortality > 0
        ? ((record.currentDayMortality - record.previousDayMortality) / record.previousDayMortality) * 100
        : record.currentDayMortality > 0
          ? Infinity
          : 0;
    const mortalitySpike = mortalityChangePercent > MORTALITY_SPIKE_THRESHOLD_PERCENT;

    const waterChangePercent =
      record.previousDayWaterConsumptionLiters > 0
        ? ((record.currentDayWaterConsumptionLiters - record.previousDayWaterConsumptionLiters) /
            record.previousDayWaterConsumptionLiters) *
          100
        : 0;
    const waterDrop = waterChangePercent <= WATER_DROP_THRESHOLD_PERCENT;

    const triggerReasons = [];
    if (mortalitySpike) {
      triggerReasons.push(
        `Mortality spiked ${mortalityChangePercent.toFixed(1)}% in 24h (${record.previousDayMortality} -> ${record.currentDayMortality})`
      );
    }
    if (waterDrop) {
      triggerReasons.push(
        `Water consumption dropped ${Math.abs(waterChangePercent).toFixed(1)}% in 24h (${record.previousDayWaterConsumptionLiters}L -> ${record.currentDayWaterConsumptionLiters}L)`
      );
    }

    return {
      mortalityChangePercent,
      waterChangePercent,
      mortalitySpike,
      waterDrop,
      outbreakDetected: mortalitySpike || waterDrop,
      triggerReasons,
    };
  }

  // Stage 3 (Integration): only reachable when an outbreak is detected.
  // Shapes the mandatory USDA/State Veterinarian notification report.
  buildUsdaNotificationReport(record, anomalyResult) {
    const lines = [
      `USDA-APHIS-NOTIFICATION|SECTOR:${record.sectorCode}|SPECIES:${record.species}|FLOCK_COUNT:${record.flockCount}`,
      `MORTALITY|PREV:${record.previousDayMortality}|CURRENT:${record.currentDayMortality}|CHANGE_PCT:${anomalyResult.mortalityChangePercent.toFixed(1)}`,
      `WATER_CONSUMPTION|PREV_L:${record.previousDayWaterConsumptionLiters}|CURRENT_L:${record.currentDayWaterConsumptionLiters}|CHANGE_PCT:${anomalyResult.waterChangePercent.toFixed(1)}`,
      `TRIGGER_REASONS|${anomalyResult.triggerReasons.join('; ')}`,
      `REPORTED_AT|${new Date().toISOString()}`,
    ];
    return lines.join('\n');
  }

  // Stage 4a (Logistics Intercept): only reachable when an outbreak is
  // detected — hard-blocks standard transport pending inspection.
  buildLogisticsHold(record, anomalyResult) {
    return {
      channel: 'corporate_logistics_hold_queue',
      priority: 'immediate_hold',
      sectorCode: record.sectorCode,
      headline: `Biosecurity outbreak suspected in sector ${record.sectorCode} — all transport suspended`,
      triggerReasons: anomalyResult.triggerReasons,
      requestedAction: 'Suspend all inbound/outbound livestock transport for this sector immediately pending state veterinarian inspection. Standard transport manifest logging is blocked until cleared.',
      transportLogsBlocked: true,
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): the sector code — needed verbatim in the
  // Stage 3 report and Stage 4a hold for operational response — is masked
  // here, since the generic SIEM audit trail should carry a reduced-
  // exposure fingerprint rather than the actionable geographic code.
  buildSplunkEvent(record, anomalyResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'livestock-biosecurity-anomaly-detector',
      source: 'hub4_veterinary_operations/livestock_biosecurity_anomaly_detector',
      sourcetype: '_json',
      event: {
        action: outcome,
        outbreakDetected: anomalyResult.outbreakDetected,
        maskedSectorCode: maskValue(record.sectorCode),
        species: record.species,
        mortalityChangePercent: anomalyResult.mortalityChangePercent,
        waterChangePercent: anomalyResult.waterChangePercent,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawMetrics) {
    const record = this.ingest(rawMetrics);
    const anomalyResult = this.detectAnomaly(record);

    if (anomalyResult.outbreakDetected) {
      const usdaReport = this.buildUsdaNotificationReport(record, anomalyResult);
      const logisticsHold = this.buildLogisticsHold(record, anomalyResult);
      const splunkEvent = this.buildSplunkEvent(record, anomalyResult, 'biosecurity_outbreak_escalated');
      return { usdaReport, logisticsHold, splunkEvent };
    }

    const splunkEvent = this.buildSplunkEvent(record, anomalyResult, 'routine_no_anomaly');
    return { usdaReport: null, logisticsHold: null, splunkEvent };
  }
}

module.exports = {
  LivestockBiosecurityAnomalyDetector,
  METRICS_ALLOWLIST,
};
