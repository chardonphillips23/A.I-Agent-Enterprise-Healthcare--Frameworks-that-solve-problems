'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const NOTE_ALLOWLIST = ['requestedProcedure', 'historyOfTreatments', 'diagnosis'];

const FIELD_PATTERNS = {
  requestedProcedure: /requested procedure:\s*([^\n]+)/i,
  historyOfTreatments: /(?:history of treatments|prior treatments|treatment history):\s*([^\n]+)/i,
  diagnosis: /diagnosis:\s*([^\n]+)/i,
};

const MEDICAL_POLICY_DICTIONARY = {
  knee_arthroplasty: {
    policyId: 'POLICY-KNEE-ARTHRO-001',
    matchKeywords: ['knee arthroplasty', 'knee replacement'],
    requiredTreatmentPattern: /physical therapy/i,
    requiredTreatmentLabel: 'physical therapy',
    requiredDurationWeeks: 6,
  },
  lumbar_fusion: {
    policyId: 'POLICY-LUMBAR-FUSION-002',
    matchKeywords: ['lumbar fusion', 'spinal fusion'],
    requiredTreatmentPattern: /(physical therapy|epidural steroid injection)/i,
    requiredTreatmentLabel: 'physical therapy or epidural steroid injection',
    requiredDurationWeeks: 12,
  },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

function extractField(noteText, pattern) {
  const match = noteText.match(pattern);
  return match ? match[1].trim() : '';
}

class PriorAuthCoordinator {
  // Stage 1 (Scribe Ingestion): pull only the three allowlisted clinical
  // concepts out of the free-text note; the raw note itself is discarded
  // after extraction and never persisted downstream.
  ingest(noteText, patientIdentifiers) {
    if (typeof noteText !== 'string' || !noteText.trim()) {
      throw new TypeError('noteText must be a non-empty string');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      requestedProcedure: extractField(noteText, FIELD_PATTERNS.requestedProcedure),
      historyOfTreatments: extractField(noteText, FIELD_PATTERNS.historyOfTreatments),
      diagnosis: extractField(noteText, FIELD_PATTERNS.diagnosis),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !NOTE_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Medical Policy Matching): match the requested procedure to a
  // mock payer policy, then verify the documented treatment history
  // satisfies that policy's conservative-treatment and duration rules.
  matchPolicy(structuredNote) {
    const procedureLower = structuredNote.requestedProcedure.toLowerCase();
    const policyEntry = Object.values(MEDICAL_POLICY_DICTIONARY).find((policy) =>
      policy.matchKeywords.some((keyword) => procedureLower.includes(keyword))
    );

    if (!policyEntry) {
      return {
        policyId: null,
        passed: false,
        missingCriteria: [
          `No medical policy on file matches requested procedure "${structuredNote.requestedProcedure}" — route to manual clinical review.`,
        ],
      };
    }

    const missingCriteria = [];
    const history = structuredNote.historyOfTreatments;

    if (!policyEntry.requiredTreatmentPattern.test(history)) {
      missingCriteria.push(
        `Documentation does not mention required conservative treatment: ${policyEntry.requiredTreatmentLabel}.`
      );
    } else {
      const durationMatch = history.match(/(\d+)\s*week/i);
      const foundWeeks = durationMatch ? parseInt(durationMatch[1], 10) : null;
      if (foundWeeks == null) {
        missingCriteria.push(
          `${policyEntry.requiredTreatmentLabel} duration not documented; policy requires at least ${policyEntry.requiredDurationWeeks} weeks.`
        );
      } else if (foundWeeks < policyEntry.requiredDurationWeeks) {
        missingCriteria.push(
          `Documented ${policyEntry.requiredTreatmentLabel} duration (${foundWeeks} weeks) is below the required minimum of ${policyEntry.requiredDurationWeeks} weeks.`
        );
      }
    }

    if (!structuredNote.diagnosis) {
      missingCriteria.push('Diagnosis field is missing from the clinical note.');
    }

    return {
      policyId: policyEntry.policyId,
      passed: missingCriteria.length === 0,
      missingCriteria,
    };
  }

  // Stage 3 (API Formulator): only reachable when Stage 2 passes. Shapes a
  // FHIR-style Claim resource with use = "preauthorization", the pattern
  // the Da Vinci PAS implementation guide uses in place of a dedicated
  // "PriorAuthorization" resource type (FHIR has no such resource).
  buildFhirPayload(structuredNote, complianceResult) {
    return {
      resourceType: 'Claim',
      meta: { profile: ['urn:mock:us-davinci-pas-claim'] },
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
      use: 'preauthorization',
      patient: { reference: `Patient/${structuredNote.subjectId}` },
      created: new Date().toISOString(),
      priority: { coding: [{ code: 'normal' }] },
      diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { text: structuredNote.diagnosis } }],
      item: [{ sequence: 1, productOrService: { text: structuredNote.requestedProcedure } }],
      supportingInfo: [
        { sequence: 1, category: { text: 'treatment-history' }, valueString: structuredNote.historyOfTreatments },
        { sequence: 2, category: { text: 'policy-match' }, valueString: complianceResult.policyId },
      ],
    };
  }

  // Stage 4a (Human-in-the-Loop): only reachable when Stage 2 fails.
  // Builds an action-oriented notification naming the exact documentation
  // gap so a nurse can fix the note without guessing.
  buildNurseNotification(structuredNote, complianceResult) {
    return {
      channel: 'clinic_nurse_queue',
      priority: 'action_required',
      subjectId: structuredNote.subjectId,
      policyId: complianceResult.policyId,
      headline: `Prior authorization blocked for "${structuredNote.requestedProcedure}" — documentation incomplete`,
      missingItems: complianceResult.missingCriteria,
      requestedAction: 'Update the clinical note with the missing items above and resubmit for prior authorization review.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Guard): Splunk HEC audit event for both outcomes —
  // approvals and compliance exceptions alike get an audit trail entry.
  buildSplunkEvent(complianceResult, outcome, structuredNote) {
    return {
      time: Date.now() / 1000,
      host: 'prior-auth-coordinator',
      source: 'hub1_billing/prior_auth',
      sourcetype: '_json',
      event: {
        subjectId: structuredNote.subjectId,
        policyId: complianceResult.policyId,
        outcome,
        passed: complianceResult.passed,
        missingCriteria: complianceResult.missingCriteria,
        requestedProcedure: structuredNote.requestedProcedure,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(noteText, patientIdentifiers) {
    const structuredNote = this.ingest(noteText, patientIdentifiers);
    const complianceResult = this.matchPolicy(structuredNote);

    if (complianceResult.passed) {
      const fhirPayload = this.buildFhirPayload(structuredNote, complianceResult);
      const splunkEvent = this.buildSplunkEvent(complianceResult, 'approved_for_submission', structuredNote);
      return { fhirPayload, nurseNotification: null, splunkEvent };
    }

    const nurseNotification = this.buildNurseNotification(structuredNote, complianceResult);
    const splunkEvent = this.buildSplunkEvent(complianceResult, 'blocked_pending_documentation', structuredNote);
    return { fhirPayload: null, nurseNotification, splunkEvent };
  }
}

module.exports = {
  PriorAuthCoordinator,
  MEDICAL_POLICY_DICTIONARY,
  NOTE_ALLOWLIST,
};
