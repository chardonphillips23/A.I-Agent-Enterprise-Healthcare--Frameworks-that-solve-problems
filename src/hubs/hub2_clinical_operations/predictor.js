'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const CLINICAL_ALLOWLIST = [
  'triageAcuity',
  'chiefComplaintCategory',
  'ageBucket',
  'vitals',
  'comorbidities',
  'arrivalHour',
];

const HIGH_RISK_COMPLAINT_CATEGORIES = new Set([
  'chest_pain',
  'stroke_symptoms',
  'sepsis',
  'respiratory_distress',
]);

const ESI_ACUITY_SCORE = { 1: 50, 2: 40, 3: 25, 4: 10, 5: 5 };

function ageToBucket(age) {
  if (age == null) return 'unknown';
  if (age < 5) return 'pediatric';
  if (age < 18) return 'adolescent';
  if (age < 65) return 'adult';
  return 'geriatric';
}

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

class EdBedCapacityPredictor {
  // Stage 1: strip direct identifiers, retain only allowlisted clinical fields
  // plus a one-way pseudonymous subject ID for downstream correlation.
  redact(rawEncounter) {
    if (!rawEncounter || typeof rawEncounter !== 'object') {
      throw new TypeError('rawEncounter must be an object');
    }
    const { mrn, dob, age, triageAcuity, chiefComplaintCategory, vitals, comorbidities, arrivalTime } = rawEncounter;
    if (!mrn || !dob || !triageAcuity) {
      throw new Error('rawEncounter requires mrn, dob, and triageAcuity');
    }

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      triageAcuity: Number(triageAcuity),
      chiefComplaintCategory: chiefComplaintCategory || 'unspecified',
      ageBucket: ageToBucket(age),
      vitals: vitals || {},
      comorbidities: Array.isArray(comorbidities) ? comorbidities : [],
      arrivalHour: arrivalTime ? new Date(arrivalTime).getHours() : null,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !CLINICAL_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2: rule-based admission risk score, with a defense-in-depth check
  // that no un-allowlisted (potentially identifying) field reached this stage.
  score(redactedRecord) {
    const leaked = Object.keys(redactedRecord).find(
      (key) => key !== 'subjectId' && !CLINICAL_ALLOWLIST.includes(key)
    );
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached scoring stage`);
    }

    let riskScore = ESI_ACUITY_SCORE[redactedRecord.triageAcuity] || 0;

    const vitals = redactedRecord.vitals;
    if (vitals.heartRate != null && (vitals.heartRate > 120 || vitals.heartRate < 50)) riskScore += 15;
    if (vitals.spo2 != null && vitals.spo2 < 92) riskScore += 20;
    if (vitals.systolicBP != null && vitals.systolicBP < 90) riskScore += 20;

    if (redactedRecord.ageBucket === 'geriatric') riskScore += 10;
    if (redactedRecord.ageBucket === 'pediatric') riskScore += 5;

    if (HIGH_RISK_COMPLAINT_CATEGORIES.has(redactedRecord.chiefComplaintCategory)) riskScore += 20;
    riskScore += redactedRecord.comorbidities.length * 5;

    let riskTier;
    let recommendedUnit;
    if (riskScore >= 70) {
      riskTier = 'high';
      recommendedUnit = 'ICU';
    } else if (riskScore >= 40) {
      riskTier = 'medium';
      recommendedUnit = 'MED_SURG_TELEMETRY';
    } else {
      riskTier = 'low';
      recommendedUnit = 'OBSERVATION';
    }

    return { ...redactedRecord, riskScore, riskTier, recommendedUnit };
  }

  // Stage 3: shape a UiPath Orchestrator queue-item payload for the
  // bed-reservation RPA robot to pick up and execute.
  buildRpaPayload(scoredRecord) {
    const priorityMap = { high: 'High', medium: 'Normal', low: 'Low' };
    const now = new Date();

    return {
      queueName: 'ED_BED_RESERVATION_QUEUE',
      priority: priorityMap[scoredRecord.riskTier],
      reference: `${scoredRecord.subjectId}-${now.getTime()}`,
      dueDate: scoredRecord.riskTier === 'high' ? now.toISOString() : null,
      specificContent: {
        subjectId: scoredRecord.subjectId,
        recommendedUnit: scoredRecord.recommendedUnit,
        riskTier: scoredRecord.riskTier,
        riskScore: scoredRecord.riskScore,
        chiefComplaintCategory: scoredRecord.chiefComplaintCategory,
        requestedAt: now.toISOString(),
      },
    };
  }

  // Stage 4: format a Splunk HTTP Event Collector (HEC) event for the
  // audit trail — pseudonymous ID and outcome metadata only, no PHI.
  buildSplunkEvent(rpaPayload) {
    return {
      time: Date.now() / 1000,
      host: 'ed-bed-capacity-predictor',
      source: 'hub1_billing/predictor',
      sourcetype: '_json',
      event: {
        subjectId: rpaPayload.specificContent.subjectId,
        action: 'ED_BED_RESERVATION_QUEUED',
        riskTier: rpaPayload.specificContent.riskTier,
        riskScore: rpaPayload.specificContent.riskScore,
        recommendedUnit: rpaPayload.specificContent.recommendedUnit,
        queueReference: rpaPayload.reference,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawEncounter) {
    const redacted = this.redact(rawEncounter);
    const scored = this.score(redacted);
    const rpaPayload = this.buildRpaPayload(scored);
    const splunkEvent = this.buildSplunkEvent(rpaPayload);
    return { rpaPayload, splunkEvent };
  }
}

module.exports = {
  EdBedCapacityPredictor,
  CLINICAL_ALLOWLIST,
  ESI_ACUITY_SCORE,
};
