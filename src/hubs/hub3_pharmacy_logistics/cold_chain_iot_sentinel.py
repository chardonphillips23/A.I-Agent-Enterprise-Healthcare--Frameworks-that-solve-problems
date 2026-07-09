"""Cold-Chain IoT Sentinel (Agent 9, Hub 3)."""

import hashlib
import os
import re
from datetime import datetime, timezone

SUBJECT_ID_PEPPER = os.environ.get("SUBJECT_ID_PEPPER", "CHANGE_ME_IN_PRODUCTION")

TELEMETRY_ALLOWLIST = ["product_name", "temperature_celsius", "reading_timestamp", "recommended_backup_unit"]

FIELD_PATTERNS = {
    "unit_id": re.compile(r"unit:\s*([^\n]+)", re.IGNORECASE),
    "product_name": re.compile(r"product:\s*([^\n]+)", re.IGNORECASE),
    "temperature": re.compile(r"temperature:\s*(-?\d+(?:\.\d+)?)\s*c", re.IGNORECASE),
    "timestamp": re.compile(r"timestamp:\s*([^\n]+)", re.IGNORECASE),
}

ADJACENT_UNIT_REGISTRY = {
    "FRIDGE-7": "FRIDGE-8",
    "FRIDGE-3": "FRIDGE-4",
}


def hash_asset_id(unit_id):
    return hashlib.sha256(f"{SUBJECT_ID_PEPPER}:{unit_id}".encode()).hexdigest()


def mask_value(value):
    s = str(value) if value is not None else ""
    if len(s) <= 2:
        return "*" * len(s)
    return f"{s[0]}{'*' * (len(s) - 2)}{s[-1]}"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def extract_field(text, pattern):
    match = pattern.search(text)
    return match.group(1).strip() if match else ""


class ColdChainIotSentinel:
    # Stage 1 (Telemetry Ingestion): the raw unit ID is only used here to
    # derive a hashed asset_id and to look up the adjacent backup unit; the
    # raw telemetry string itself is discarded after extraction.
    def ingest(self, telemetry_text):
        if not isinstance(telemetry_text, str) or not telemetry_text.strip():
            raise TypeError("telemetry_text must be a non-empty string")

        unit_id_raw = extract_field(telemetry_text, FIELD_PATTERNS["unit_id"])
        if not unit_id_raw:
            raise ValueError("telemetry_text requires a Unit identifier")
        temperature_match = FIELD_PATTERNS["temperature"].search(telemetry_text)
        if not temperature_match:
            raise ValueError("telemetry_text requires a Temperature reading in Celsius")

        record = {
            "asset_id": hash_asset_id(unit_id_raw),
            "product_name": extract_field(telemetry_text, FIELD_PATTERNS["product_name"]) or "unspecified",
            "temperature_celsius": float(temperature_match.group(1)),
            "reading_timestamp": extract_field(telemetry_text, FIELD_PATTERNS["timestamp"]) or iso_now(),
            "recommended_backup_unit": ADJACENT_UNIT_REGISTRY.get(unit_id_raw, "CENTRAL_COLD_STORAGE_BACKUP"),
        }

        for key in list(record.keys()):
            if key != "asset_id" and key not in TELEMETRY_ALLOWLIST:
                del record[key]
        return record

    # Stage 2 (Compliance & Cold-Chain Rules): defense-in-depth guard, then
    # check the reading against the strict 2°C-8°C safe storage window.
    def evaluate_cold_chain(self, record):
        leaked = next((k for k in record if k != "asset_id" and k not in TELEMETRY_ALLOWLIST), None)
        if leaked:
            raise ValueError(f'Compliance violation: unexpected field "{leaked}" reached evaluation stage')

        within_range = 2 <= record["temperature_celsius"] <= 8
        spoilage_incident = not within_range
        severity = None
        if spoilage_incident:
            severity = "warming_excursion" if record["temperature_celsius"] > 8 else "freezing_excursion"

        return {"within_range": within_range, "spoilage_incident": spoilage_incident, "severity": severity}

    # Stage 3 (Integration): only reachable on a spoilage incident. Shapes a
    # supply-chain redistribution ticket to move stock to the backup unit.
    def build_redistribution_payload(self, record, cold_chain_result):
        return {
            "ticket_type": "cold_chain_redistribution",
            "asset_id": record["asset_id"],
            "product_name": record["product_name"],
            "severity": cold_chain_result["severity"],
            "transfer_to": record["recommended_backup_unit"],
            "temperature_at_incident": record["temperature_celsius"],
            "requested_at": iso_now(),
        }

    # Stage 4a (Facilities Intercept): only reachable on a spoilage incident.
    def build_facilities_ticket(self, record, cold_chain_result):
        return {
            "channel": "facilities_emergency_queue",
            "priority": "urgent_work_order",
            "asset_id": record["asset_id"],
            "headline": f'Cold chain excursion detected — {cold_chain_result["severity"]}',
            "detail": f'Recorded {record["temperature_celsius"]}°C, outside the 2-8°C safe storage range for {record["product_name"]}.',
            "requested_action": "Dispatch facilities engineering immediately; confirm product transfer to the backup unit and inspect the refrigeration unit.",
            "created_at": iso_now(),
        }

    # Stage 4b (Audit Telemetry): Splunk HEC event on every reading, with
    # the product name masked before it reaches the log.
    def build_splunk_event(self, record, cold_chain_result, outcome):
        return {
            "time": datetime.now(timezone.utc).timestamp(),
            "host": "cold-chain-iot-sentinel",
            "source": "hub3_pharmacy_logistics/cold_chain_iot_sentinel",
            "sourcetype": "_json",
            "event": {
                "asset_id": record["asset_id"],
                "action": outcome,
                "within_range": cold_chain_result["within_range"],
                "severity": cold_chain_result["severity"],
                "temperature_celsius": record["temperature_celsius"],
                "product_name": mask_value(record["product_name"]),
                "processed_at": iso_now(),
            },
        }

    def run(self, telemetry_text):
        record = self.ingest(telemetry_text)
        cold_chain_result = self.evaluate_cold_chain(record)

        if cold_chain_result["spoilage_incident"]:
            redistribution_payload = self.build_redistribution_payload(record, cold_chain_result)
            facilities_ticket = self.build_facilities_ticket(record, cold_chain_result)
            splunk_event = self.build_splunk_event(record, cold_chain_result, "spoilage_incident_escalated")
            return {"redistribution_payload": redistribution_payload, "facilities_ticket": facilities_ticket, "splunk_event": splunk_event}

        splunk_event = self.build_splunk_event(record, cold_chain_result, "within_safe_range")
        return {"redistribution_payload": None, "facilities_ticket": None, "splunk_event": splunk_event}
