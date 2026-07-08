'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const DISCHARGE_ALLOWLIST = ['medications', 'followUpTimelines', 'activityRestrictions'];

const SECTION_PATTERNS = {
  medications: /medications:\s*([\s\S]*?)(?=\n\s*(?:follow-?up|activity restrictions):|$)/i,
  followUpTimelines: /follow-?up:\s*([\s\S]*?)(?=\n\s*(?:medications|activity restrictions):|$)/i,
  activityRestrictions: /activity restrictions:\s*([\s\S]*?)(?=\n\s*(?:medications|follow-?up):|$)/i,
};

const PHARMACY_OPERATIONAL_DB = {
  lisinopril: { stockStatus: 'in_stock', openHour: 8, closeHour: 20 },
  metformin: { stockStatus: 'in_stock', openHour: 8, closeHour: 20 },
  warfarin: { stockStatus: 'special_order', openHour: 9, closeHour: 17 },
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

function lookupPharmacy(name) {
  return PHARMACY_OPERATIONAL_DB[name.toLowerCase()] || { stockStatus: 'unknown', openHour: null, closeHour: null };
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class DischargeOrchestrator {
  // Stage 1 (Discharge Text Parsing): digest the free-text discharge
  // summary into the three allowlisted blocks. The raw summary text is
  // discarded after extraction and never persisted downstream.
  parse(dischargeText, patientIdentifiers) {
    if (typeof dischargeText !== 'string' || !dischargeText.trim()) {
      throw new TypeError('dischargeText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const medicationLines = extractListItems(extractField(dischargeText, SECTION_PATTERNS.medications));

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      medications: medicationLines.map(parseMedicationLine),
      followUpTimelines: extractListItems(extractField(dischargeText, SECTION_PATTERNS.followUpTimelines)),
      activityRestrictions: extractListItems(extractField(dischargeText, SECTION_PATTERNS.activityRestrictions)),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !DISCHARGE_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Safety & Pharmacy Match): flag any medication missing dosage
  // or frequency, then cross-check each medication against a mock pharmacy
  // operational-hours database to confirm it can actually be fulfilled now.
  validateSafety(structuredDischarge, atHour = new Date().getHours()) {
    const issues = [];

    const medicationsValidated = structuredDischarge.medications.map((med) => {
      const complete = Boolean(med.dosage) && Boolean(med.frequency);
      if (!complete) {
        issues.push(`Medication "${med.name}" is missing ${!med.dosage ? 'dosage' : 'frequency'} information.`);
      }

      const pharmacy = lookupPharmacy(med.name);
      let fulfillable;
      if (pharmacy.stockStatus === 'unknown') {
        fulfillable = false;
        issues.push(`Medication "${med.name}" is not in the pharmacy operational database; manual verification required.`);
      } else if (pharmacy.stockStatus !== 'in_stock') {
        fulfillable = false;
        issues.push(`Medication "${med.name}" is a special-order item and cannot be guaranteed for immediate fulfillment.`);
      } else {
        fulfillable = atHour >= pharmacy.openHour && atHour < pharmacy.closeHour;
        if (!fulfillable) {
          issues.push(`Medication "${med.name}" requested outside pharmacy operational hours (${pharmacy.openHour}:00-${pharmacy.closeHour}:00).`);
        }
      }

      return { ...med, complete, fulfillable };
    });

    return {
      medicationsValidated,
      allComplete: medicationsValidated.every((med) => med.complete),
      allFulfillable: medicationsValidated.every((med) => med.fulfillable),
      issues,
    };
  }

  buildPatientInstructions(structuredDischarge) {
    const lines = ['YOUR DISCHARGE INSTRUCTIONS', '', 'Your Medicines:'];
    structuredDischarge.medications.forEach((med) => {
      lines.push(`- Take ${med.name}, ${med.dosage || 'ask your nurse for the dose'}, ${med.frequency || 'ask your nurse when'}.`);
    });
    lines.push('', 'Your Next Appointments:');
    structuredDischarge.followUpTimelines.forEach((item) => lines.push(`- ${item}`));
    lines.push('', 'Things To Avoid:');
    structuredDischarge.activityRestrictions.forEach((item) => lines.push(`- ${item}`));
    lines.push('', 'A nurse will call you in 2 days to check how you feel.');
    return lines.join('\n');
  }

  buildEPrescribingPayload(structuredDischarge) {
    return structuredDischarge.medications.map((med, index) => ({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${structuredDischarge.subjectId}` },
      medicationCodeableConcept: { text: med.name },
      dosageInstruction: [{ text: `${med.dosage} ${med.frequency}`.trim() }],
      identifier: [{ value: `${structuredDischarge.subjectId}-rx-${index + 1}` }],
    }));
  }

  buildSchedulingRequest(structuredDischarge) {
    const windowStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const windowEnd = new Date(windowStart.getTime() + 2 * 60 * 60 * 1000);
    return {
      ticketType: 'telehealth_follow_up',
      subjectId: structuredDischarge.subjectId,
      visitType: 'telehealth',
      priority: 'standard',
      requestedWindowStart: windowStart.toISOString(),
      requestedWindowEnd: windowEnd.toISOString(),
      notes: 'Automated 48-hour post-discharge safety check-in',
    };
  }

  // Stage 3 (Multi-Channel Dispatcher): bundle the three outbound payload
  // shapes together, carrying forward Stage 2's issues as visible flags
  // rather than silently dropping them.
  buildDispatchBundle(structuredDischarge, safetyReport) {
    return {
      patientInstructions: this.buildPatientInstructions(structuredDischarge),
      ePrescribing: this.buildEPrescribingPayload(structuredDischarge),
      schedulingRequest: this.buildSchedulingRequest(structuredDischarge),
      safetyFlags: safetyReport.issues,
    };
  }

  // Stage 4 (Cryptographic & Access Control Guard): reject the request
  // outright if no valid-looking OAuth2 bearer token is present.
  validateAccessToken(headers) {
    const authHeader = headers && headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Access denied: missing or malformed OAuth2 bearer token');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length < 20) {
      throw new Error('Access denied: OAuth2 token failed validation');
    }
    return { valid: true, tokenFingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) };
  }

  // Stage 4 (Audit Guard): mask clinical fields before they ever reach the
  // Splunk HEC event, so the audit trail carries a fingerprint of what
  // happened without persisting plaintext medication data into log storage.
  buildSplunkEvent(dispatchBundle, tokenValidation, structuredDischarge) {
    const maskedMedications = structuredDischarge.medications.map((med) => ({
      name: maskValue(med.name),
      dosage: maskValue(med.dosage),
    }));

    return {
      time: Date.now() / 1000,
      host: 'discharge-orchestrator',
      source: 'hub1_billing/discharge_orchestrator',
      sourcetype: '_json',
      event: {
        subjectId: structuredDischarge.subjectId,
        action: 'DISCHARGE_HANDOFF_DISPATCHED',
        tokenFingerprint: tokenValidation.tokenFingerprint,
        maskedMedications,
        safetyFlagCount: dispatchBundle.safetyFlags.length,
        followUpWindowStart: dispatchBundle.schedulingRequest.requestedWindowStart,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(dischargeText, patientIdentifiers, requestHeaders) {
    const structuredDischarge = this.parse(dischargeText, patientIdentifiers);
    const safetyReport = this.validateSafety(structuredDischarge);
    const dispatchBundle = this.buildDispatchBundle(structuredDischarge, safetyReport);
    const tokenValidation = this.validateAccessToken(requestHeaders);
    const splunkEvent = this.buildSplunkEvent(dispatchBundle, tokenValidation, structuredDischarge);
    return { dispatchBundle, safetyReport, splunkEvent };
  }
}

module.exports = {
  DischargeOrchestrator,
  PHARMACY_OPERATIONAL_DB,
  DISCHARGE_ALLOWLIST,
};
