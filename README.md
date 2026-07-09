# Enterprise Healthcare Agentic Automation Framework (EHAAF)

EHAAF is a modular, production-oriented framework of autonomous agents built to remove critical bottlenecks in hospital operations, revenue cycles, and clinical workflows. Every agent in the framework — regardless of domain — is built on the same secure, 4-stage asynchronous event engine, so compliance guarantees and integration patterns are uniform across the entire system rather than reinvented per module. The goal is a library of narrow, auditable, drop-in agents that hospital IT and revenue-cycle teams can wire into existing EHR, pharmacy, RPA, and SIEM infrastructure without re-deriving data-handling safeguards each time.

## Core Architectural Pattern (The 4-Stage Pipeline)

Every agent in this framework strictly adheres to a uniform data-handling lifecycle. This is not a stylistic convention — it's what lets every module be reasoned about, audited, and certified the same way.

### Stage 1: Ingestion & Triage (Data Hygiene)

Raw input — whether an unstructured clinical note, a discharge summary, or a structured claim record — is parsed exactly once, and only the fields on an explicit **structural allowlist** survive into the output object. Anything not named on that allowlist (including fields nobody thought to blocklist) is discarded before the record leaves the ingestion function; the raw source text/object is never retained. In parallel, any direct patient identifiers (MRN, DOB, SSN, etc.) are collapsed into a single one-way **pseudonymous `subjectId`** via SHA-256 hashed with a server-side pepper (`hash(pepper:mrn:dob)`), giving every downstream stage a stable correlation key without ever holding the identifier itself. Together, the allowlist and the pseudonymous hash establish the HIPAA-aligned boundary the rest of the pipeline operates behind.

### Stage 2: Compliance & Business Logic Rules

Each agent's scoring/rules engine opens with a **defense-in-depth guard**: it re-scans the incoming record's keys against the Stage 1 allowlist before doing any business logic. If a field shows up that isn't on that allowlist — for instance because a future code change to Stage 1 accidentally let something new through — the guard throws an immediate compliance error and halts execution rather than silently processing (and potentially propagating) an unvetted field. Only after that check passes does the stage apply its domain rules: CARC-code denial classification, ESI-based admission risk scoring, medical-necessity policy matching, or medication/pharmacy validation, depending on the module.

### Stage 3: Integration & Payload Formulation

Once Stage 2 clears a record, this stage maps the validated, scored data into standardized enterprise integration schemas rather than ad hoc JSON. Where a real interoperability standard exists, the framework uses it: prior authorization payloads are shaped as a FHIR `Claim` resource with `use: "preauthorization"` (the HL7 Da Vinci PAS pattern, since FHIR has no dedicated "PriorAuthorization" resource type), and pharmacy/e-prescribing payloads are shaped as FHIR `MedicationRequest` resources. Other modules emit RPA-orchestrator queue items (UiPath-shaped) or scheduling-system tickets. The common thread: Stage 3 output is always a schema a downstream enterprise system is already built to consume, not a bespoke internal format.

### Stage 4: Telemetry & Log Hygiene (Splunk Ingestion)

The final stage formats an audit event for ingestion into enterprise SIEM platforms. Events are shaped for the Splunk HTTP Event Collector (HEC) contract — `time`, `host`, `source`, `sourcetype: "_json"`, and a nested `event` body — so they can be posted directly to a HEC endpoint with no transformation layer in between. The `event` body is deliberately minimal: pseudonymous `subjectId`, action/outcome metadata, and (where a cryptographic check occurred) a **token fingerprint** rather than the raw token or credential. Where clinical values do need to appear in a log for debugging purposes, they are masked before being written. This stage runs on every outcome path — success and failure/exception alike — so the audit trail is never silently incomplete.

## Active Framework Modules (The Hubs)

### Hub 1: Revenue Cycle Management

- **Insurance Claim Denial & Appeals Engine** (`src/hubs/hub1_revenue_cycle/claims_denial.js`) — Classifies denials by CARC code against a payer policy dictionary, computes the appeal deadline and required-documentation gap, scores financial recovery priority (dollar value, deadline proximity, document readiness), and routes the outcome to a write-off, documentation-gathering, or appeal-submission action.

### Hub 2: Clinical Operations & Care Coordination

- **Emergency Department Bed Capacity Predictor** (`src/hubs/hub2_clinical_operations/predictor.js`) — Scores ED admission risk from ESI triage acuity, vital-sign abnormalities, age bucket, and complaint category, then pre-allocates a recommended unit (ICU / Med-Surg-Telemetry / Observation) via an automated bed-reservation RPA payload.
- **Automated Electronic Prior Authorization (ePA) Coordinator** (`src/hubs/hub2_clinical_operations/prior_auth.js`) — Extracts requested procedure, treatment history, and diagnosis from unstructured clinical notes, checks them against a dynamic medical policy dictionary (required conservative treatment + duration), and either formulates a FHIR prior-auth `Claim` or blocks submission with a specific, action-oriented documentation request to clinic staff.
- **Hospital Discharge & Post-Care Handoff Orchestrator** (`src/hubs/hub2_clinical_operations/discharge_orchestrator.js`) — Parses a multi-line discharge summary into medications, follow-up timelines, and activity restrictions; validates medication completeness and pharmacy fulfillment capability; and dispatches synchronized plain-language patient instructions, an e-prescribing payload, and a 48-hour follow-up telehealth scheduling request.
- **Automated Medication Reconciliation & Drug-Interaction Sentinel** (`src/hubs/hub2_clinical_operations/med_reconciliation.js`) — Cross-references home medications against new hospital orders using a clinical risk dictionary, blocking reconciliation and alerting the attending physician on any high-risk interaction (e.g., Warfarin + NSAIDs), or committing a unified FHIR `MedicationRequest` bundle when clear.
- **ICU Acuity Sentinel** (`src/hubs/hub2_clinical_operations/icu_acuity_sentinel.js`) — Computes a Modified Early Warning Score (MEWS) from respiration rate, heart rate, systolic BP, and temperature; always emits an HL7 v2 `ORU^R01` telemetry message for continuous monitoring, and additionally pages the attending physician STAT when MEWS reaches 5 or higher.
- **Telehealth Triage Router** (`src/hubs/hub2_clinical_operations/telehealth_triage_router.js`) — Scans telehealth chat text for acute-risk keywords (chest pain, stroke symptoms, suicidal ideation, respiratory distress), classifies a triage level, and routes critical/urgent cases to an instant WebRTC or Twilio escalation link; routine sessions get no escalation payload.

### Hub 3: Pharmacy Logistics & Supply Chain

- **Substance Compliance Guard** (`src/hubs/hub3_pharmacy_logistics/substance_compliance_guard.js`) — Checks Schedule II refill requests against a mock state PDMP database; blocks and issues a DEA audit exception if less than 85% of the prior fill's days-supply has elapsed, otherwise clears a FHIR `MedicationRequest` carrying mock provenance-compliance extensions.
- **Cold-Chain IoT Sentinel** (`src/hubs/hub3_pharmacy_logistics/cold_chain_iot_sentinel.js`) — Parses refrigerator telemetry for biologic storage (insulin, mRNA vaccines), flags a spoilage incident if the reading falls outside the strict 2°C–8°C safe-storage window, and on excursion emits both a stock-redistribution routing payload and an urgent facilities work ticket.
- **Compounding Allergy Auditor** (`src/hubs/hub3_pharmacy_logistics/compounding_allergy_auditor.js`) — Cross-references IV compounding chemical components against a patient's allergy profile (normalizing plural/singular mismatches, e.g. "Penicillin" vs. "Penicillins"), hard-blocking the compound and alerting the cleanroom lab tech on any anaphylactic cross-reactivity risk.

### Hub 4: Veterinary Practice Management & Animal Health Networks

- **Companion Toxicosis Sentinel** (`src/hubs/hub4_veterinary_operations/companion_toxicosis_sentinel.js`) — Screens ingested-substance emergencies (chocolate, xylitol, grapes for canines; lilies, acetaminophen for felines) against a species-specific, weight-scaled toxic-dose ratio; always posts a PIMS whiteboard triage entry, and on a ratio at or above the lethal-dose-equivalent threshold, triggers a STAT decontamination alert.
- **Equine Telemetry MEWS** (`src/hubs/hub4_veterinary_operations/equine_telemetry_mews.js`) — Computes an Equine Early Warning Score (EEWS) from stall IoT vitals, weighted so that heart rate above 60 bpm or capillary refill time above 2 seconds can trip a critical colic-crisis alert on its own; always emits a PIMS dashboard vitals string, and pages the on-call large-animal field surgeon when EEWS reaches 5 or higher.
- **Avian/Exotic Dosage Guard** (`src/hubs/hub4_veterinary_operations/avian_exotic_dosage_guard.js`) — Applies a strict micrograms-per-gram safety ceiling for sub-1000g (avian/reptilian) patients, failing closed to a pharmacist intercept if the requested dose exceeds the ceiling or if no ceiling is on file for the drug, otherwise clearing a cleanroom compounding label.
- **Shelter Intake Quarantine Router** (`src/hubs/hub4_veterinary_operations/shelter_intake_quarantine_router.js`) — Cross-references intake symptoms against a contagious-disease matrix (canine parvovirus, feline leukemia, feline panleukopenia, rabies vector); high-risk matches are hard-routed to isolation housing with a biohazard cleaning ticket, with an explicit guard that refuses to let a positive match reach general-population housing.
- **Livestock Biosecurity Anomaly Detector** (`src/hubs/hub4_veterinary_operations/livestock_biosecurity_anomaly_detector.js`) — Flags a state-level biosecurity outbreak when 24-hour mortality spikes past 300% or water consumption drops sharply for a sector; on detection, hard-blocks standard transport logging, issues a corporate logistics hold, and formulates the mandatory USDA/State Veterinarian notification report.

### Hub 5: Medical Imaging AI & Pathology Automation

- **DICOM Stroke Triage** (`src/hubs/hub5_imaging_pathology/dicom_stroke_triage.js`) — Reads a simulated pixel-density intracranial hemorrhage classifier score off DICOM header metadata; always emits an HL7 v2 `MDM^T02` document notification, and on a CT study scoring at or above 0.85 confidence, dispatches a STAT neurology pager alert.
- **Critical Biopsy Sentinel** (`src/hubs/hub5_imaging_pathology/critical_biopsy_sentinel.js`) — Regex-screens pathology findings text against hyper-aggressive malignancy keys (malignant melanoma, high-grade glioblastoma, acute myeloid leukemia, small cell lung carcinoma) and, on a match, formulates an expedited FHIR `ServiceRequest` routed directly to oncology scheduling.
- **Radiology Peer Review Auditor** (`src/hubs/hub5_imaging_pathology/radiology_peer_review_auditor.js`) — Cross-checks an AI computer-vision diagnostic tag against the human radiologist's impression text; if the AI names a critical finding (e.g. pulmonary embolism) while the human report uses routine negative language, routes the case into the mandatory Senior QA peer review worklist. The audit log carries only a content fingerprint and a numeric variance index — never the report text itself.
- **Specimen Mismatch Guard** (`src/hubs/hub5_imaging_pathology/specimen_mismatch_guard.js`) — Cross-references a lab specimen barcode's anatomical site against the live EHR surgical booking (e.g. left lung vs. right lung); on conflict, hard-blocks the lab dashboard and sounds an audible cleanroom terminal alarm rather than letting the specimen proceed to processing.
- **Radiation Safety Dose Sentinel** (`src/hubs/hub5_imaging_pathology/radiation_safety_dose_sentinel.js`) — Converts an incoming CT/X-ray order's DLP (Dose Length Product) to an estimated effective dose and projects it against the patient's cumulative lifetime exposure; at or above the 50 mSv threshold, issues a clinical-decision-support soft-block requiring an active radiologist signature before the scan proceeds.

## 📁 Repository Layout & Contribution Standards

```
src/
└── hubs/
    ├── hub1_revenue_cycle/
    │   └── claims_denial.js
    ├── hub2_clinical_operations/
    │   ├── predictor.js
    │   ├── prior_auth.js
    │   ├── discharge_orchestrator.js
    │   ├── med_reconciliation.js
    │   ├── icu_acuity_sentinel.js
    │   └── telehealth_triage_router.js
    ├── hub3_pharmacy_logistics/
    │   ├── substance_compliance_guard.js
    │   ├── cold_chain_iot_sentinel.js
    │   └── compounding_allergy_auditor.js
    ├── hub4_veterinary_operations/
    │   ├── companion_toxicosis_sentinel.js
    │   ├── equine_telemetry_mews.js
    │   ├── avian_exotic_dosage_guard.js
    │   ├── shelter_intake_quarantine_router.js
    │   └── livestock_biosecurity_anomaly_detector.js
    └── hub5_imaging_pathology/
        ├── dicom_stroke_triage.js
        ├── critical_biopsy_sentinel.js
        ├── radiology_peer_review_auditor.js
        ├── specimen_mismatch_guard.js
        └── radiation_safety_dose_sentinel.js
```

Every agent module lives inside its designated operational hub directory under `src/hubs/` — never as a flat file directly in `src/`. Hub directories group agents by business domain (revenue cycle, clinical operations, and any future hub), keeping the module count per directory legible as the framework grows.

⚠️ **MANDATORY DIRECTORY POLICY:** All future AI agent modules added to this framework must be sequentially numbered and mandatorily deployed inside their designated operational hub directory. Flat file additions to the root `src/` folder are strictly prohibited to maintain architectural integrity.

## Production & Compliance Considerations

This framework, as implemented, represents the **code-level architecture layer** — the data-handling discipline, rules structure, and integration schemas an agent should follow. It is not, by itself, a certified HIPAA-compliant or production-hardened deployment. Before any module in this repository touches real patient data, a production deployment additionally requires:

- **Identity & access management:** integration with an enterprise Identity Provider for real OAuth2/OIDC token issuance and JWT signature, expiry, audience, and scope validation — the token checks in this repository are illustrative shape-validators, not cryptographic verification.
- **Key/secret management:** the SHA-256 pseudonymization pepper must be sourced from a managed key vault (e.g., AWS KMS, Azure Key Vault, HashiCorp Vault) with rotation policy, not an environment-variable placeholder.
- **Encryption in transit and at rest:** TLS for all inter-service calls (EHR, RPA orchestrator, SIEM) and encryption at rest for any datastore the pipeline touches.
- **Business Associate Agreements (BAAs):** with every third-party vendor in the data path (RPA platform, SIEM provider, cloud host) before any real PHI flows through these integrations.
- **Clinical and regulatory validation:** the risk-scoring and policy-matching logic in Hub 2 modules are illustrative rule engines, not clinically validated predictive models — real deployment against real admission/authorization decisions requires clinical review and, depending on use, regulatory clearance.
- **Hub 4 regulatory scope note:** HIPAA governs human PHI and does not apply to animal patient data — the owner/pet-name hashing pattern in Hub 4 is carried over as a data-privacy best practice for consistency, not a HIPAA obligation. Hub 4's actual regulatory surface is different (state veterinary boards, DEA rules for controlled substances in animals, and USDA/APHIS reportable-disease requirements for the livestock biosecurity module) and needs its own compliance review before production use.
- **Hub 5 regulatory scope note:** the hemorrhage classifier score in `dicom_stroke_triage.js` and the malignancy keyword screen in `critical_biopsy_sentinel.js` are simulated/mocked scoring stand-ins, not real trained models — an actual AI diagnostic aid making triage decisions from imaging or pathology data is regulated as Software as a Medical Device (SaMD) and would need FDA clearance (or equivalent) before clinical use, independent of the data-handling architecture demonstrated here.
