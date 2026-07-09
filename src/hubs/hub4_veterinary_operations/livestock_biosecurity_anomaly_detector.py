"""Livestock Biosecurity Anomaly Detector (Agent 15, Hub 4)."""

import math
from datetime import datetime, timezone

METRICS_ALLOWLIST = [
    "sector_code",
    "species",
    "flock_count",
    "previous_day_mortality",
    "current_day_mortality",
    "previous_day_water_consumption_liters",
    "current_day_water_consumption_liters",
    "feed_consumption_kg",
]

MORTALITY_SPIKE_THRESHOLD_PERCENT = 300
WATER_DROP_THRESHOLD_PERCENT = -30


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LivestockBiosecurityAnomalyDetector:
    # Stage 1 (Production Metrics Ingestion): unlike patient-facing agents,
    # sector_code is retained verbatim rather than hashed — a real USDA/state
    # outbreak notification (Stage 3) is useless without the actual
    # geographic location, so there is no direct patient identifier to
    # pseudonymize here in the first place.
    def ingest(self, raw_metrics):
        if not isinstance(raw_metrics, dict):
            raise TypeError("raw_metrics must be a dict")

        sector_code = raw_metrics.get("sector_code")
        species = raw_metrics.get("species")
        flock_count = raw_metrics.get("flock_count")
        previous_day_mortality = raw_metrics.get("previous_day_mortality")
        current_day_mortality = raw_metrics.get("current_day_mortality")
        previous_day_water_consumption_liters = raw_metrics.get("previous_day_water_consumption_liters")
        current_day_water_consumption_liters = raw_metrics.get("current_day_water_consumption_liters")
        feed_consumption_kg = raw_metrics.get("feed_consumption_kg")

        if not sector_code or not species:
            raise ValueError("raw_metrics requires sector_code and species")
        if any(
            v is None
            for v in [
                flock_count,
                previous_day_mortality,
                current_day_mortality,
                previous_day_water_consumption_liters,
                current_day_water_consumption_liters,
                feed_consumption_kg,
            ]
        ):
            raise ValueError(
                "raw_metrics requires flock_count, previous_day_mortality, current_day_mortality, "
                "previous_day_water_consumption_liters, current_day_water_consumption_liters, and feed_consumption_kg"
            )

        record = {
            "sector_code": sector_code,
            "species": species,
            "flock_count": float(flock_count),
            "previous_day_mortality": float(previous_day_mortality),
            "current_day_mortality": float(current_day_mortality),
            "previous_day_water_consumption_liters": float(previous_day_water_consumption_liters),
            "current_day_water_consumption_liters": float(current_day_water_consumption_liters),
            "feed_consumption_kg": float(feed_consumption_kg),
        }

        for key in list(record.keys()):
            if key not in METRICS_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Statistical Anomaly Detection): defense-in-depth guard, then
    # flag a mortality spike (>300% in 24h) or a sharp water-consumption
    # drop (>=30% in 24h) as a biosecurity outbreak signal.
    def detect_anomaly(self, record):
        leaked = next((k for k in record if k not in METRICS_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached anomaly detection stage')

        if record["previous_day_mortality"] > 0:
            mortality_change_percent = ((record["current_day_mortality"] - record["previous_day_mortality"]) / record["previous_day_mortality"]) * 100
        elif record["current_day_mortality"] > 0:
            mortality_change_percent = math.inf
        else:
            mortality_change_percent = 0
        mortality_spike = mortality_change_percent > MORTALITY_SPIKE_THRESHOLD_PERCENT

        if record["previous_day_water_consumption_liters"] > 0:
            water_change_percent = (
                (record["current_day_water_consumption_liters"] - record["previous_day_water_consumption_liters"])
                / record["previous_day_water_consumption_liters"]
            ) * 100
        else:
            water_change_percent = 0
        water_drop = water_change_percent <= WATER_DROP_THRESHOLD_PERCENT

        trigger_reasons = []
        if mortality_spike:
            trigger_reasons.append(
                f'Mortality spiked {mortality_change_percent:.1f}% in 24h ({record["previous_day_mortality"]} -> {record["current_day_mortality"]})'
            )
        if water_drop:
            trigger_reasons.append(
                f'Water consumption dropped {abs(water_change_percent):.1f}% in 24h '
                f'({record["previous_day_water_consumption_liters"]}L -> {record["current_day_water_consumption_liters"]}L)'
            )

        return {
            "mortality_change_percent": mortality_change_percent,
            "water_change_percent": water_change_percent,
            "mortality_spike": mortality_spike,
            "water_drop": water_drop,
            "outbreak_detected": mortality_spike or water_drop,
            "trigger_reasons": trigger_reasons,
        }

    # Stage 3 (Integration): only reachable when an outbreak is detected.
    # Shapes the mandatory USDA/State Veterinarian notification report.
    def build_usda_notification_report(self, record, anomaly_result):
        lines = [
            f'USDA-APHIS-NOTIFICATION|SECTOR:{record["sector_code"]}|SPECIES:{record["species"]}|FLOCK_COUNT:{record["flock_count"]}',
            f'MORTALITY|PREV:{record["previous_day_mortality"]}|CURRENT:{record["current_day_mortality"]}|CHANGE_PCT:{anomaly_result["mortality_change_percent"]:.1f}',
            f'WATER_CONSUMPTION|PREV_L:{record["previous_day_water_consumption_liters"]}|CURRENT_L:{record["current_day_water_consumption_liters"]}|CHANGE_PCT:{anomaly_result["water_change_percent"]:.1f}',
            f'TRIGGER_REASONS|{"; ".join(anomaly_result["trigger_reasons"])}',
            f"REPORTED_AT|{iso_now()}",
        ]
        return "\n".join(lines)

    # Stage 4a (Logistics Intercept): only reachable when an outbreak is
    # detected — hard-blocks standard transport pending inspection.
    def build_logistics_hold(self, record, anomaly_result):
        return {
            "channel": "corporate_logistics_hold_queue",
            "priority": "immediate_hold",
            "sector_code": record["sector_code"],
            "headline": f'Biosecurity outbreak suspected in sector {record["sector_code"]} — all transport suspended',
            "trigger_reasons": anomaly_result["trigger_reasons"],
            "requested_action": "Suspend all inbound/outbound livestock transport for this sector immediately pending state veterinarian inspection. Standard transport manifest logging is blocked until cleared.",
            "transport_logs_blocked": True,
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): the sector code — needed verbatim in the
    # Stage 3 report and Stage 4a hold for operational response — is masked
    # here, since the generic SIEM audit trail should carry a reduced-
    # exposure fingerprint rather than the actionable geographic code.
    def build_splunk_event(self, record, anomaly_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "livestock-biosecurity-anomaly-detector",
            "source": "hub4_veterinary_operations/livestock_biosecurity_anomaly_detector",
            "sourcetype": "_json",
            "event": {
                "action": outcome,
                "outbreak_detected": anomaly_result["outbreak_detected"],
                "masked_sector_code": mask_value(record["sector_code"]),
                "species": record["species"],
                "mortality_change_percent": anomaly_result["mortality_change_percent"],
                "water_change_percent": anomaly_result["water_change_percent"],
                "processed_at": iso_now(),
            },
        }

    def run(self, raw_metrics):
        record = self.ingest(raw_metrics)
        anomaly_result = self.detect_anomaly(record)

        if anomaly_result["outbreak_detected"]:
            usda_report = self.build_usda_notification_report(record, anomaly_result)
            logistics_hold = self.build_logistics_hold(record, anomaly_result)
            splunk_event = self.build_splunk_event(record, anomaly_result, "biosecurity_outbreak_escalated")
            return {"usda_report": usda_report, "logistics_hold": logistics_hold, "splunk_event": splunk_event}

        splunk_event = self.build_splunk_event(record, anomaly_result, "routine_no_anomaly")
        return {"usda_report": None, "logistics_hold": None, "splunk_event": splunk_event}
