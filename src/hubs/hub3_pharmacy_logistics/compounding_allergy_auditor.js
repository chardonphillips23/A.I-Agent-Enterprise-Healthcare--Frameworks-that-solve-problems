'use strict';

const crypto = require('crypto');

const SUBJECT_ID_PEPPER = process.env.SUBJECT_ID_PEPPER || 'CHANGE_ME_IN_PRODUCTION';

const COMPOUND_ALLOWLIST = ['components', 'allergyProfile'];

const CROSS_REACTIVITY_MAP = {
  penicillin: {
    allergyKeywords: ['penicillin', 'penicillins', 'amoxicillin', 'ampicillin'],
    reactionRisk: 'anaphylaxis',
  },
  cephalosporin: {
    allergyKeywords: ['cephalosporin', 'cephalosporins', 'cefazolin'],
    reactionRisk: 'anaphylaxis_cross_reactivity',
  },
  sulfa: {
    allergyKeywords: ['sulfa', 'sulfonamide', 'sulfonamides'],
    reactionRisk: 'anaphylaxis',
  },
};

function hashSubjectId(mrn, dob) {
  return crypto
    .createHash('sha256')
    .update(`${SUBJECT_ID_PEPPER}:${mrn}:${dob}`)
    .digest('hex');
}

function maskValue(value) {
  const str = String(value ?? '');
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

function normalize(str) {
  return String(str).toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
}

function extractComponentName(segment) {
  const trimmed = segment.trim();
  const match = trimmed.match(/^([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)*)/);
  return match ? match[1].trim() : trimmed;
}

class CompoundingAllergyAuditor {
  // Stage 1 (Formula Ingestion): split the compounding order into its
  // chemical component names and pair them with the patient's allergy
  // profile; the raw formula string is discarded after extraction.
  ingest(formulaText, allergyProfile, patientIdentifiers) {
    if (typeof formulaText !== 'string' || !formulaText.trim()) {
      throw new TypeError('formulaText must be a non-empty string');
    }
    if (!Array.isArray(allergyProfile)) {
      throw new TypeError('allergyProfile must be an array');
    }
    const { mrn, dob } = patientIdentifiers || {};
    if (!mrn || !dob) {
      throw new Error('patientIdentifiers requires mrn and dob to derive a subjectId');
    }

    const components = formulaText
      .split('+')
      .map(extractComponentName)
      .filter(Boolean);

    const record = {
      subjectId: hashSubjectId(mrn, dob),
      components,
      allergyProfile: allergyProfile.map(String),
    };

    for (const key of Object.keys(record)) {
      if (key !== 'subjectId' && !COMPOUND_ALLOWLIST.includes(key)) {
        delete record[key];
      }
    }
    return record;
  }

  // Stage 2 (Compliance & Cross-Reactivity Rules): defense-in-depth guard,
  // then normalize component and allergy names (handling plural mismatches
  // like "Penicillin" vs. "Penicillins") to find any cross-reactivity.
  auditCrossReactivity(record) {
    const leaked = Object.keys(record).find((key) => key !== 'subjectId' && !COMPOUND_ALLOWLIST.includes(key));
    if (leaked) {
      throw new Error(`Compliance violation: unexpected field "${leaked}" reached audit stage`);
    }

    const conflicts = [];
    for (const component of record.components) {
      const componentNorm = normalize(component);
      const mapEntry = Object.entries(CROSS_REACTIVITY_MAP).find(([key]) => componentNorm.includes(key));
      if (!mapEntry) continue;

      const [, info] = mapEntry;
      for (const allergy of record.allergyProfile) {
        const allergyNorm = normalize(allergy);
        const isMatch = info.allergyKeywords.some((keyword) => normalize(keyword) === allergyNorm);
        if (isMatch) {
          conflicts.push({ component, allergy, reactionRisk: info.reactionRisk });
        }
      }
    }

    return { conflicts, cleared: conflicts.length === 0 };
  }

  // Stage 3 (Integration): only reachable when Stage 2 clears the order.
  // Shapes a cleanroom compound verification record.
  buildCleanroomVerification(record) {
    return {
      verificationType: 'CleanroomCompoundVerification',
      status: 'verified',
      subjectId: record.subjectId,
      components: record.components,
      allergyProfileChecked: record.allergyProfile,
      verificationId: `CRV-${record.subjectId.slice(0, 10)}-${Date.now()}`,
      verifiedAt: new Date().toISOString(),
    };
  }

  // Stage 4a (Cleanroom Intercept): only reachable on a cross-reactivity
  // conflict — the verification payload is never generated on this path.
  buildCleanroomIntercept(record, auditResult) {
    return {
      channel: 'cleanroom_lab_tech_intercept',
      priority: 'hard_block',
      subjectId: record.subjectId,
      headline: 'STOP: anaphylactic cross-reactivity risk detected in compounding order',
      conflicts: auditResult.conflicts.map(
        (c) => `Component "${c.component}" conflicts with documented allergy "${c.allergy}" — risk: ${c.reactionRisk}.`
      ),
      requestedAction: 'Do not compound as ordered. Contact the prescriber to select a non-cross-reactive alternative before proceeding.',
      createdAt: new Date().toISOString(),
    };
  }

  // Stage 4b (Audit Telemetry): fully masked Splunk audit log — component
  // and allergy names are masked before they ever reach the log.
  buildSplunkEvent(record, auditResult, outcome) {
    return {
      time: Date.now() / 1000,
      host: 'compounding-allergy-auditor',
      source: 'hub3_pharmacy_logistics/compounding_allergy_auditor',
      sourcetype: '_json',
      event: {
        subjectId: record.subjectId,
        action: outcome,
        cleared: auditResult.cleared,
        conflictCount: auditResult.conflicts.length,
        maskedConflicts: auditResult.conflicts.map((c) => ({
          component: maskValue(c.component),
          allergy: maskValue(c.allergy),
          reactionRisk: c.reactionRisk,
        })),
        processedAt: new Date().toISOString(),
      },
    };
  }

  run(formulaText, allergyProfile, patientIdentifiers) {
    const record = this.ingest(formulaText, allergyProfile, patientIdentifiers);
    const auditResult = this.auditCrossReactivity(record);

    if (auditResult.cleared) {
      const verification = this.buildCleanroomVerification(record);
      const splunkEvent = this.buildSplunkEvent(record, auditResult, 'cleared_for_compounding');
      return { verification, intercept: null, splunkEvent };
    }

    const intercept = this.buildCleanroomIntercept(record, auditResult);
    const splunkEvent = this.buildSplunkEvent(record, auditResult, 'blocked_cross_reactivity');
    return { verification: null, intercept, splunkEvent };
  }
}

module.exports = {
  CompoundingAllergyAuditor,
  CROSS_REACTIVITY_MAP,
  COMPOUND_ALLOWLIST,
};
