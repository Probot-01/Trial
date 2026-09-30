import React from 'react';
import { drGradeLabels } from '../../api/mockData';

export const BranchComparisonPanel = ({ caseData }) => {
  const c = caseData;
  const isMismatch = c.branchAgreement === false;

  return (
    <div className={`branch-comparison ${isMismatch ? 'branch-comparison--mismatch' : ''}`} style={{ border: 'var(--border)' }}>
      <div style={{ padding: 'var(--sp-4) var(--sp-6)', borderBottom: 'var(--border)' }}>
        <h3 className="t-h3">GRADING COMPARISON</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {/* CNN Branch A */}
        <div className="branch-card" style={{ padding: 'var(--sp-6)', borderRight: 'var(--border)' }}>
          <span className="t-label" style={{ opacity: 0.5 }}>CNN BRANCH A</span>
          <div className="branch-card__grade" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="t-display" style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)' }}>
              {c.drGradeCnn !== null ? c.drGradeCnn : '—'}
            </span>
          </div>
          <span className="t-mono" style={{ fontWeight: 700, marginTop: 'var(--sp-2)', display: 'block' }}>
            {c.drGradeCnn !== null ? drGradeLabels[c.drGradeCnn] : 'NOT YET AVAILABLE'}
          </span>
        </div>

        {/* Rule Engine Branch B */}
        <div className="branch-card" style={{ padding: 'var(--sp-6)' }}>
          <span className="t-label" style={{ opacity: 0.5 }}>RULE ENGINE B</span>
          <div className="branch-card__grade" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="t-display" style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)' }}>
              {c.drGradeRuleEngine !== null ? c.drGradeRuleEngine : '—'}
            </span>
          </div>
          <span className="t-mono" style={{ fontWeight: 700, marginTop: 'var(--sp-2)', display: 'block' }}>
            {c.drGradeRuleEngine !== null ? drGradeLabels[c.drGradeRuleEngine] : 'NOT YET AVAILABLE'}
          </span>
        </div>
      </div>

      {/* Agreement Status */}
      <div className={`branch-agreement-bar ${isMismatch ? 'branch-agreement-bar--mismatch' : ''}`}>
        {c.branchAgreement === null ? (
          c.drGradeRuleEngine === null ? (
            <span className="t-mono" style={{ opacity: 0.3 }}>BRANCH B DID NOT RUN FOR THIS CASE — SINGLE-BRANCH MODE</span>
          ) : (
            // The rule engine caps at RULE_MAX_GRADE=3: it DID run and returned a
            // grade, but that grade is a lower bound ("at least 3"), not a value
            // that can be checked for agreement against the CNN's grade.
            <span className="t-mono" style={{ color: 'var(--c-warning)', fontWeight: 700 }}>
              ⚠ RULE ENGINE HIT ITS CEILING (GRADE {c.drGradeRuleEngine} MEANS "AT LEAST {c.drGradeRuleEngine}") — NOT DIRECTLY COMPARABLE TO THE CNN GRADE
            </span>
          )
        ) : c.branchAgreement ? (
          <span className="t-mono" style={{ color: 'var(--c-success)', fontWeight: 700 }}>
            ✓ BRANCHES AGREE — GRADE {c.drGradeCnn} CONFIRMED BY BOTH PIPELINES
          </span>
        ) : (
          <span className="t-mono" style={{ color: 'white', fontWeight: 700 }}>
            ⚠ BRANCHES DISAGREE — CNN: GRADE {c.drGradeCnn} vs RULE ENGINE: GRADE {c.drGradeRuleEngine} — MANDATORY MANUAL REVIEW REQUIRED
          </span>
        )}
      </div>
    </div>
  );
};
