'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const INTAKE_ALLOWLIST = ['species', 'symptoms'];

const DISEASE_MATRIX = {
  canine_parvovirus: {
    speciesMatch: ['canine', 'dog'],
    symptomKeywords: ['bloody diarrhea', 'vomiting', 'lethargy', 'parvo'],
    quarantineTier: 'strict_isolation',
  },
  feline_leukemia: {
    speciesMatch: ['feline', 'cat'],
    symptomKeywords: ['feline leukemia', 'felv', 'weight loss', 'chronic infection'],
    quarantineTier: 'strict_isolation',
  },
  feline_panleukopenia: {
    speciesMatch: ['feline', 'cat'],
    symptomKeywords: ['panleukopenia', 'severe vomiting', 'bloody diarrhea'],
    quarantineTier: 'strict_isolation',
  },
  rabies_vector: {
    speciesMatch: ['canine', 'feline', 'dog', 'cat', 'wildlife'],
    symptomKeywords: ['rabies vector', 'unprovoked aggression', 'neurological signs', 'unknown bite wound'],
    quarantineTier: 'rabies_observation_hold',
  },
};

function hashIntakeId(strayId) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${strayId}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

class ShelterIntakeQuarantineRouter {
  // Stage 1 (Intake Ingestion): the raw stray identifier is only used to
  // derive a hashed intakeId; species and symptom list survive.
  ingest(intakeRecord) {
    if (!intakeRecord || typeof intakeRecord !== 'object') {
      throw new TypeError('intakeRecord must be an object');
    }
    const { strayId, species, symptoms } = intakeRecord;
    if (!strayId) {
      throw new Error('intakeRecord requires strayId to derive an intakeId');
    }
    if (!species) {
      throw new Error('intakeRecord requires species');
    }

    const record = {
      intakeId: hashIntakeId(strayId),
      species,
      symptoms: Array.isArray(symptoms) ? symptoms.map(String) : [],
    };

    for (const key of Object.keys(record)) {
      if (key !== 'intakeId' && !INTAKE_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Infectious Disease Screening): defense-in-depth guard, then
  // cross-reference species and symptom keywords against the disease matrix.
  evaluateQuarantineRisk(record) {
    const leaked = Object.keys(record).find((key) => key !== 'intakeId' && !INTAKE_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached screening stage`);
    }

    const speciesLower = record.species.toLowerCase();
    const symptomsLower = record.symptoms.map((s) => s.toLowerCase());
    const matches = [];

    for (const [diseaseKey, info] of Object.entries(DISEASE_MATRIX)) {
      const speciesOk = info.speciesMatch.some((s) => speciesLower.includes(s));
      if (!speciesOk) continue;
      const symptomMatch = info.symptomKeywords.some((keyword) => symptomsLower.some((sym) => sym.includes(keyword)));
      if (symptomMatch) {
        matches.push({ diseaseKey, quarantineTier: info.quarantineTier });
      }
    }

    const highRisk = matches.length > 0;
    return { matches, highRisk, quarantineTier: highRisk ? matches[0].quarantineTier : 'general_population_eligible' };
  }

  // Stage 3a (Integration): housing assignment — always generated, since
  // every intake gets assigned somewhere.
  buildHousingAssignment(record, riskResult) {
    return {
      ticketType: 'housing_assignment',
      intakeId: record.intakeId,
      species: record.species,
      assignedWard: riskResult.highRisk ? 'ISOLATION_WARD_QUARANTINE' : 'GENERAL_POPULATION_WARD',
      quarantineTier: riskResult.quarantineTier,
      assignedAt: new Date().toISOString(),
    };
  }

  // Stage 3b (Integration): only reachable on a high-risk match.
  buildBiohazardTicket(record, riskResult) {
    return {
      channel: 'biohazard_cleaning_queue',
      priority: 'urgent',
      intakeId: record.intakeId,
      detectedDiseases: riskResult.matches.map((m) => m.diseaseKey),
      requestedAction: 'Perform full biohazard-protocol decontamination of the intake area before processing the next animal.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4 (Access Control Guard): reject the request outright if no
  // valid-looking security signature is present.
  validateSecuritySignature(headers) {
    const authHeader = headers && headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Access denied: missing or malformed security signature');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length < 20) {
      throw new Error('Access denied: security signature failed validation');
    }
    return { valid: true, tokenFingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) };
  }

  // Stage 4 (Audit Telemetry): masked Splunk audit event on every intake.
  buildSplunkEvent(record, riskResult, housingAssignment, tokenValidation) {
    return {
      time: Date.now() / 1000,
      host: 'shelter-intake-quarantine-router',
      source: 'hub4_veterinary_operations/shelter_intake_quarantine_router',
      sourcetype: '_json',
      event: {
        intakeId: record.intakeId,
        action: riskResult.highRisk ? 'quarantine_isolation_assigned' : 'general_population_assigned',
        highRisk: riskResult.highRisk,
        detectedDiseases: riskResult.matches.map((m) => m.diseaseKey),
        assignedWard: housingAssignment.assignedWard,
        tokenFingerprint: tokenValidation.tokenFingerprint,
        maskedSymptoms: record.symptoms.map((s) => maskValue(s)),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(intakeRecord, requestHeaders) {
    const record = this.ingest(intakeRecord);
    const riskResult = this.evaluateQuarantineRisk(record);
    const housingAssignment = this.buildHousingAssignment(record, riskResult);

    if (riskResult.highRisk && housingAssignment.assignedWard === 'GENERAL_POPULATION_WARD') {
      throw new Error('Compliance violation: high-risk intake routed to general population ward');
    }

    const biohazardTicket = riskResult.highRisk ? this.buildBiohazardTicket(record, riskResult) : null;
    const tokenValidation = this.validateSecuritySignature(requestHeaders);
    const splunkEvent = this.buildSplunkEvent(record, riskResult, housingAssignment, tokenValidation);
    return { housingAssignment, biohazardTicket, splunkEvent };
  }
}

module.exports = {
  ShelterIntakeQuarantineRouter,
  DISEASE_MATRIX,
  INTAKE_ALLOWLIST,
};
