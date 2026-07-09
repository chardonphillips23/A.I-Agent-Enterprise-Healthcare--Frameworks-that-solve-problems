'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const SIGNALMENT_ALLOWLIST = ['species', 'breed', 'ageYears', 'weightKg', 'ingestedSubstance', 'ingestedGrams'];

const FIELD_PATTERNS = {
  ownerName: /owner:\s*([^\n]+)/i,
  petName: /pet name:\s*([^\n]+)/i,
  species: /species:\s*([^\n]+)/i,
  breed: /breed:\s*([^\n]+)/i,
  age: /age:\s*(\d+(?:\.\d+)?)/i,
  weight: /weight\s*\(?kg\)?:\s*(\d+(?:\.\d+)?)/i,
  ingestedSubstance: /ingested substance:\s*([^\n]+)/i,
  ingestedGrams: /estimated ingested grams:\s*(\d+(?:\.\d+)?)/i,
};

// Simplified, illustrative toxicity model — NOT clinically authoritative.
// toxicPrincipalMgPerGram is the mock mg-of-toxin-per-gram-of-substance
// concentration; lethalDoseMgPerKg is the mock mg/kg body weight threshold.
const TOXICOSIS_RISK_INDEX = {
  canine: {
    chocolate: { toxicPrincipal: 'theobromine', toxicPrincipalMgPerGram: 10, lethalDoseMgPerKg: 60 },
    xylitol: { toxicPrincipal: 'xylitol', toxicPrincipalMgPerGram: 1000, lethalDoseMgPerKg: 100 },
    grapes: { toxicPrincipal: 'unidentified nephrotoxin', toxicPrincipalMgPerGram: 1, lethalDoseMgPerKg: 19 },
  },
  feline: {
    lilies: { toxicPrincipal: 'unidentified nephrotoxin', toxicPrincipalMgPerGram: 1, lethalDoseMgPerKg: 0 },
    acetaminophen: { toxicPrincipal: 'acetaminophen', toxicPrincipalMgPerGram: 500, lethalDoseMgPerKg: 50 },
  },
};

function hashSubjectId(ownerName, petName) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${ownerName}:${petName}`)
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

class CompanionToxicosisSentinel {
  // Stage 1 (Emergency Ingestion): owner name and pet name are only used
  // here to derive a hashed subjectId; only signalment and ingestion
  // details survive into the record.
  ingest(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new TypeError('rawText must be a non-empty string');
    }
    const ownerName = extractField(rawText, FIELD_PATTERNS.ownerName);
    const petName = extractField(rawText, FIELD_PATTERNS.petName);
    if (!ownerName || !petName) {
      throw new Error('rawText requires Owner and Pet Name to derive a subjectId');
    }

    const weightMatch = rawText.match(FIELD_PATTERNS.weight);
    if (!weightMatch) {
      throw new Error('rawText requires a Weight (kg) reading');
    }

    const record = {
      subjectId: hashSubjectId(ownerName, petName),
      species: extractField(rawText, FIELD_PATTERNS.species) || 'unknown',
      breed: extractField(rawText, FIELD_PATTERNS.breed) || 'unknown',
      ageYears: parseFloat(extractField(rawText, FIELD_PATTERNS.age)) || null,
      weightKg: parseFloat(weightMatch[1]),
      ingestedSubstance: extractField(rawText, FIELD_PATTERNS.ingestedSubstance) || 'unknown',
      ingestedGrams: parseFloat(extractField(rawText, FIELD_PATTERNS.ingestedGrams)) || 0,
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !SIGNALMENT_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Toxicosis Risk Screening): defense-in-depth guard, then look
  // up the ingested substance in the species-specific risk index and
  // compute a toxic-dose ratio scaled by the patient's body weight.
  computeToxicity(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !SIGNALMENT_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached toxicity screening stage`);
    }

    const speciesLower = record.species.toLowerCase();
    const speciesKey = speciesLower.includes('cat') || speciesLower.includes('feline') ? 'feline' : 'canine';
    const substanceLower = record.ingestedSubstance.toLowerCase();
    const substanceKey = Object.keys(TOXICOSIS_RISK_INDEX[speciesKey]).find((key) => substanceLower.includes(key));

    if (!substanceKey) {
      return { recognized: false, toxicPrincipal: null, toxicRatio: 0, criticalRisk: false };
    }

    const entry = TOXICOSIS_RISK_INDEX[speciesKey][substanceKey];
    const totalToxicMg = record.ingestedGrams * entry.toxicPrincipalMgPerGram;
    const doseMgPerKg = record.weightKg > 0 ? totalToxicMg / record.weightKg : Infinity;
    const toxicRatio = entry.lethalDoseMgPerKg > 0 ? doseMgPerKg / entry.lethalDoseMgPerKg : (totalToxicMg > 0 ? Infinity : 0);

    return {
      recognized: true,
      substanceKey,
      toxicPrincipal: entry.toxicPrincipal,
      doseMgPerKg,
      toxicRatio,
      criticalRisk: toxicRatio >= 1,
    };
  }

  // Stage 3 (Integration): PIMS emergency whiteboard entry — generated on
  // every case, since the whiteboard reflects every patient in triage.
  buildWhiteboardTriage(record, toxResult) {
    const ratioDisplay = Number.isFinite(toxResult.toxicRatio) ? toxResult.toxicRatio.toFixed(2) : 'INF';
    const lines = [
      `PIMS-WHITEBOARD|${record.subjectId}|SPECIES:${record.species}|BREED:${record.breed}|AGE:${record.ageYears ?? 'unknown'}y|WEIGHT:${record.weightKg}kg`,
      `INGESTION|SUBSTANCE:${record.ingestedSubstance}|AMOUNT_G:${record.ingestedGrams}|TOXIC_PRINCIPAL:${toxResult.toxicPrincipal || 'unrecognized'}`,
      `RISK|RATIO:${ratioDisplay}|STATUS:${toxResult.criticalRisk ? 'STAT' : 'MONITOR'}`,
    ];
    return lines.join('\n');
  }

  // Stage 4a (Clinical Sentinel Intercept): only built when the toxic
  // ratio reaches or exceeds the lethal-dose-equivalent threshold.
  buildDecontaminationAlert(record, toxResult) {
    return {
      channel: 'stat_decontamination_team',
      priority: 'stat',
      subjectId: record.subjectId,
      headline: `STAT: toxic ingestion ratio ${toxResult.toxicRatio.toFixed(2)}x lethal-dose-equivalent for ${record.ingestedSubstance}`,
      detail: `${record.species} (${record.breed}), ${record.weightKg}kg ingested ~${record.ingestedGrams}g of ${record.ingestedSubstance} (${toxResult.toxicPrincipal}).`,
      requestedAction: 'Initiate emesis induction/activated charcoal protocol immediately per toxicology guidance; prepare IV fluids and continuous monitoring.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): masked Splunk event on every case.
  buildSplunkEvent(record, toxResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'companion-toxicosis-sentinel',
      source: 'hub4_veterinary_operations/companion_toxicosis_sentinel',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        criticalRisk: toxResult.criticalRisk,
        toxicRatio: toxResult.toxicRatio,
        maskedSubstance: maskValue(record.ingestedSubstance),
        species: record.species,
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(rawText) {
    const record = this.ingest(rawText);
    const toxResult = this.computeToxicity(record);
    const whiteboardPayload = this.buildWhiteboardTriage(record, toxResult);
    const decontaminationAlert = toxResult.criticalRisk ? this.buildDecontaminationAlert(record, toxResult) : null;
    const splunkEvent = this.buildSplunkEvent(
      record,
      toxResult,
      decontaminationAlert ? 'stat_decontamination_triggered' : 'routine_monitoring'
    );
    return { whiteboardPayload, decontaminationAlert, splunkEvent, toxicRatio: toxResult.toxicRatio, criticalRisk: toxResult.criticalRisk };
  }
}

module.exports = {
  CompanionToxicosisSentinel,
  TOXICOSIS_RISK_INDEX,
  SIGNALMENT_ALLOWLIST,
};
