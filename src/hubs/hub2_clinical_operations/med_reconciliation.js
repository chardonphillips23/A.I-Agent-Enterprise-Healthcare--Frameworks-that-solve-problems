'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const MED_LIST_ALLOWLIST = ['homeMedications', 'newOrders'];

const SECTION_PATTERNS = {
  homeMedications: /home medications:\s*([\s\S]*?)(?=\n\s*(?:new orders|hospital medications):|$)/i,
  newOrders: /(?:new orders|hospital medications):\s*([\s\S]*?)(?=\n\s*(?:home medications):|$)/i,
};

const CLINICAL_RISK_DICTIONARY = {
  warfarin: {
    interactsWith: ['aspirin', 'ibuprofen', 'naproxen'],
    riskCategory: 'bleeding_risk',
    severity: 'critical',
    mechanism: 'Concurrent NSAID/antiplatelet use potentiates anticoagulant effect, elevating GI and intracranial hemorrhage risk.',
    alternativeSuggestion: 'Consider acetaminophen for analgesia; if antiplatelet therapy is required, consult cardiology before co-administration.',
  },
  lisinopril: {
    interactsWith: ['spironolactone', 'potassium chloride'],
    riskCategory: 'hyperkalemia_risk',
    severity: 'high',
    mechanism: 'ACE inhibitor combined with a potassium-sparing agent increases risk of dangerous hyperkalemia.',
    alternativeSuggestion: 'Monitor serum potassium closely, or consider a non-potassium-sparing alternative.',
  },
  metformin: {
    interactsWith: ['iodinated contrast'],
    riskCategory: 'lactic_acidosis_risk',
    severity: 'high',
    mechanism: 'Iodinated contrast media can impair renal clearance of metformin, increasing lactic acidosis risk.',
    alternativeSuggestion: 'Hold metformin at the time of contrast administration and for 48 hours post-procedure.',
  },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

function extractField(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : '';
}

function extractListItems(sectionText) {
  if (!sectionText) return [];
  return sectionText
    .split('\n')
    .map((line) => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean);
}

function parseMedicationLine(line) {
  const match = line.match(/^(.+?)\s+(\d+\s?(?:mg|mcg|ml|g|units))\b\s*(.*)$/i);
  if (!match) {
    return { name: line.trim(), dosage: '', frequency: '' };
  }
  return { name: match[1].trim(), dosage: match[2].trim(), frequency: match[3].trim() };
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class MedReconciliationSentinel {
  // Stage 1 (Medication List Ingestion): isolate home-medication and
  // new-order lines into structured {name, dosage, frequency} entries.
  // The raw note text is discarded after extraction and never persisted.
  ingest(medicationText, patientIdentifiers) {
    if (typeof medicationText !== 'string' || !medicationText.trim()) {
      throw new TypeError('medicationText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const homeLines = extractListItems(extractField(medicationText, SECTION_PATTERNS.homeMedications));
    const newOrderLines = extractListItems(extractField(medicationText, SECTION_PATTERNS.newOrders));

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      homeMedications: homeLines.map(parseMedicationLine),
      newOrders: newOrderLines.map(parseMedicationLine),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !MED_LIST_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Clinical Risk & Interaction Screening): defense-in-depth guard
  // re-validates the record against the Stage 1 allowlist before cross-
  // referencing home medications against new orders in the risk dictionary.
  screenInteractions(structuredList) {
    const leaked = Object.keys(structuredList).find(
      (key) => key !== 'subjectId' && !MED_LIST_ALLOWLIST.includes(key)
    );
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached screening stage`);
    }

    const conflicts = [];
    for (const homeMed of structuredList.homeMedications) {
      const riskEntry = CLINICAL_RISK_DICTIONARY[homeMed.name.toLowerCase()];
      if (!riskEntry) continue;

      for (const newOrder of structuredList.newOrders) {
        const isInteracting = riskEntry.interactsWith.some((drug) =>
          newOrder.name.toLowerCase().includes(drug)
        );
        if (isInteracting) {
          conflicts.push({
            homeMedication: homeMed.name,
            newOrder: newOrder.name,
            riskCategory: riskEntry.riskCategory,
            severity: riskEntry.severity,
            mechanism: riskEntry.mechanism,
            alternativeSuggestion: riskEntry.alternativeSuggestion,
          });
        }
      }
    }

    return { conflicts, passed: conflicts.length === 0 };
  }

  // Stage 3 (Automated Order Adjustment Formulator): only reachable when
  // Stage 2 finds zero conflicts. Shapes a FHIR Bundle of MedicationRequest
  // resources unifying home medications and new orders into one record.
  buildReconciledFhirBundle(structuredList) {
    const toEntry = (med, category) => ({
      resource: {
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        category: [{ text: category }],
        subject: { reference: `Patient/${structuredList.subjectId}` },
        medicationCodeableConcept: { text: med.name },
        dosageInstruction: [{ text: `${med.dosage} ${med.frequency}`.trim() }],
      },
    });

    return {
      resourceType: 'Bundle',
      type: 'collection',
      meta: { tag: [{ system: 'urn:mock:med-reconciliation', code: 'reconciled' }] },
      timestamp: new Date().toISOString(),
      entry: [
        ...structuredList.homeMedications.map((med) => toEntry(med, 'home-medication')),
        ...structuredList.newOrders.map((med) => toEntry(med, 'hospital-new-order')),
      ],
    };
  }

  // Stage 4a (Clinical Sentinel Intercept): only reachable when Stage 2
  // flags a conflict. Blocks the reconciled payload and builds an urgent,
  // specific alert for the attending physician naming the exact interaction
  // and a suggested alternative.
  buildClinicalIntercept(structuredList, screeningResult) {
    return {
      channel: 'attending_physician_intercept',
      priority: 'critical_stop',
      subjectId: structuredList.subjectId,
      headline: 'STOP: high-risk drug interaction detected between home medication and new order',
      conflicts: screeningResult.conflicts.map(
        (c) =>
          `${c.homeMedication} (home) + ${c.newOrder} (new order): ${c.riskCategory} [${c.severity}] — ${c.mechanism} Suggested alternative: ${c.alternativeSuggestion}`
      ),
      requestedAction: 'Do not administer the new order as written. Review the conflict(s) above and select an alternative before proceeding.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): Splunk HEC audit event for both outcomes.
  // Drug names are masked before they ever reach the log so the audit
  // trail carries no plaintext clinical identifiers.
  buildSplunkEvent(screeningResult, outcome, structuredList) {
    const maskedConflicts = screeningResult.conflicts.map((c) => ({
      homeMedication: maskValue(c.homeMedication),
      newOrder: maskValue(c.newOrder),
      riskCategory: c.riskCategory,
      severity: c.severity,
    }));

    return {
      time: Date.now() / 1000,
      host: 'med-reconciliation-sentinel',
      source: 'hub2_clinical/med_reconciliation',
      sourcetype: '_json',
      event: {
        subjectId: structuredList.subjectId,
        action: outcome,
        passed: screeningResult.passed,
        conflictCount: screeningResult.conflicts.length,
        maskedConflicts,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(medicationText, patientIdentifiers) {
    const structuredList = this.ingest(medicationText, patientIdentifiers);
    const screeningResult = this.screenInteractions(structuredList);

    if (screeningResult.passed) {
      const fhirBundle = this.buildReconciledFhirBundle(structuredList);
      const splunkEvent = this.buildSplunkEvent(screeningResult, 'reconciled_and_committed', structuredList);
      return { fhirBundle, clinicalIntercept: null, splunkEvent };
    }

    const clinicalIntercept = this.buildClinicalIntercept(structuredList, screeningResult);
    const splunkEvent = this.buildSplunkEvent(screeningResult, 'blocked_critical_interaction', structuredList);
    return { fhirBundle: null, clinicalIntercept, splunkEvent };
  }
}

module.exports = {
  MedReconciliationSentinel,
  CLINICAL_RISK_DICTIONARY,
  MED_LIST_ALLOWLIST,
};
