import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { drGradeLabels } from '../../api/mockData';
import { InfoBanner } from '../shared/InfoBanner';

// Inline SVG retinal fundus component — severity controls how many lesion markers appear
const FundusSvg = ({ severity = 1 }) => {
  return (
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ background: '#1A0A05', display: 'block' }}>
      <defs>
        <radialGradient id={`fundus-bg-${severity}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8B3A1A" stopOpacity="0.6" />
          <stop offset="45%" stopColor="#4A1A08" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#1A0A05" stopOpacity="1" />
        </radialGradient>
        <radialGradient id={`optic-disc-${severity}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFE8B0" stopOpacity="0.95" />
          <stop offset="70%" stopColor="#FFCC70" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#CC8833" stopOpacity="0.3" />
        </radialGradient>
      </defs>

      <circle cx="100" cy="100" r="90" fill={`url(#fundus-bg-${severity})`} />

      <path d="M130 85 Q140 70 155 50 Q162 38 170 25" fill="none" stroke="#C44430" strokeWidth="3.5" strokeLinecap="round" opacity="0.85" />
      <path d="M130 85 Q145 90 165 95 Q175 97 185 100" fill="none" stroke="#C44430" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
      <path d="M130 115 Q145 120 160 135 Q170 148 175 160" fill="none" stroke="#C44430" strokeWidth="3.2" strokeLinecap="round" opacity="0.82" />
      <path d="M130 115 Q140 130 150 155 Q155 168 158 178" fill="none" stroke="#B33825" strokeWidth="2.8" strokeLinecap="round" opacity="0.75" />

      <path d="M130 90 Q148 75 160 60 Q168 48 172 35" fill="none" stroke="#882218" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
      <path d="M130 110 Q150 115 170 110 Q180 108 190 105" fill="none" stroke="#882218" strokeWidth="3.5" strokeLinecap="round" opacity="0.65" />
      <path d="M130 110 Q145 125 155 145 Q162 160 168 175" fill="none" stroke="#882218" strokeWidth="3.8" strokeLinecap="round" opacity="0.68" />

      <path d="M155 50 Q160 42 168 30" fill="none" stroke="#AA3828" strokeWidth="1.8" strokeLinecap="round" opacity="0.6" />
      <path d="M165 95 Q172 90 180 82" fill="none" stroke="#AA3828" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <path d="M160 135 Q168 140 178 148" fill="none" stroke="#993322" strokeWidth="1.8" strokeLinecap="round" opacity="0.55" />
      <path d="M150 155 Q148 165 145 178" fill="none" stroke="#993322" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />

      <path d="M130 90 Q115 75 100 55 Q90 42 78 30" fill="none" stroke="#C44430" strokeWidth="2.5" strokeLinecap="round" opacity="0.65" />
      <path d="M130 95 Q110 90 90 92 Q75 93 55 97" fill="none" stroke="#882218" strokeWidth="2.8" strokeLinecap="round" opacity="0.5" />
      <path d="M130 110 Q110 115 90 125 Q75 133 60 145" fill="none" stroke="#C44430" strokeWidth="2.2" strokeLinecap="round" opacity="0.6" />
      <path d="M130 108 Q115 120 100 140 Q88 155 75 170" fill="none" stroke="#882218" strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />

      <circle cx="130" cy="100" r="16" fill={`url(#optic-disc-${severity})`} stroke="#DDAA55" strokeWidth="0.5" opacity="0.9" />
      <circle cx="130" cy="100" r="6" fill="#FFFFFF" opacity="0.2" />

      <circle cx="85" cy="100" r="12" fill="#2A0D05" opacity="0.5" />
      <circle cx="85" cy="100" r="5" fill="#1A0805" opacity="0.6" />

      {severity >= 1 && (
        <>
          <circle cx="72" cy="88" r="2" fill="#FF4444" opacity="0.8" />
          <circle cx="78" cy="112" r="1.5" fill="#FF4444" opacity="0.7" />
        </>
      )}

      {severity >= 2 && (
        <>
          <circle cx="65" cy="95" r="2.5" fill="#DD2222" opacity="0.75" />
          <circle cx="90" cy="80" r="2" fill="#FF4444" opacity="0.7" />
          <circle cx="60" cy="108" r="3" fill="#CC1111" opacity="0.6" />
          <circle cx="95" cy="118" r="2" fill="#FF3333" opacity="0.65" />
          <circle cx="70" cy="75" r="1.8" fill="#FF4444" opacity="0.6" />
        </>
      )}

      {severity >= 3 && (
        <>
          <circle cx="75" cy="92" r="4" fill="#BB1111" opacity="0.55" />
          <circle cx="55" cy="100" r="3.5" fill="#AA0000" opacity="0.5" />
          <circle cx="80" cy="120" r="3" fill="#CC2222" opacity="0.6" />
          <circle cx="62" cy="85" r="2.5" fill="#FFDD88" opacity="0.5" />
          <circle cx="90" cy="110" r="2" fill="#FFCC66" opacity="0.45" />
          <circle cx="68" cy="115" r="2.2" fill="#FFDD88" opacity="0.5" />
          <ellipse cx="55" cy="88" rx="5" ry="3" fill="#FFFFFF" opacity="0.15" />
        </>
      )}

      {severity >= 4 && (
        <>
          <path d="M75 95 Q68 88 62 82 Q58 78 55 72" fill="none" stroke="#FF3322" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
          <path d="M75 95 Q70 100 65 108 Q60 115 55 120" fill="none" stroke="#FF3322" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
          <path d="M62 82 Q58 80 52 78" fill="none" stroke="#FF2211" strokeWidth="0.8" strokeLinecap="round" opacity="0.5" />
          <circle cx="50" cy="95" r="5" fill="#990000" opacity="0.3" />
        </>
      )}

      <circle cx="100" cy="100" r="90" fill="none" stroke="#C42B2B" strokeWidth="1" opacity="0.3" />
    </svg>
  );
};

// The system's real referral statuses (ReferralTrackerPage.jsx / api-contracts.md):
// referred -> contacted -> attended | lost, with manual_follow_up a parallel
// state (SMS delivery failed) rather than a forward step. This used to list
// 'SCHEDULED'/'SEEN', which do not exist -- a genuinely attended case matched
// none of the four hardcoded steps and rendered as if referral had not started.
const REFERRAL_STEPS = ['referred', 'contacted', 'attended'];
const ReferralTracker = ({ status }) => {
  const { t } = useTranslation();
  if (!status) return null;

  if (status === 'lost' || status === 'manual_follow_up') {
    return (
      <div className="u-flex u-items-center u-gap-2 u-mt-2">
        <span className={`badge ${status === 'lost' ? 'badge--fail' : 'badge--warning'}`} style={{ fontSize: '10px' }}>
          {status === 'lost'
            ? t('central.timeline.steps.lost', 'LOST TO FOLLOW-UP')
            : t('central.timeline.steps.manualFollowUp', 'MANUAL FOLLOW-UP — SMS NOT DELIVERED')}
        </span>
      </div>
    );
  }

  const currentIndex = REFERRAL_STEPS.indexOf(status);
  return (
    <div className="u-flex u-items-center u-gap-2 u-mt-2">
      {REFERRAL_STEPS.map((step, idx) => (
        <div key={step} className="u-flex u-items-center u-gap-2">
          <div style={{
            width: '12px', height: '12px', borderRadius: '50%',
            backgroundColor: idx <= currentIndex ? 'var(--c-crimson)' : 'transparent',
            border: '2px solid var(--c-crimson)',
            transition: 'background-color 0.3s ease',
          }} />
          <span className="t-mono" style={{ fontSize: '10px', opacity: idx <= currentIndex ? 1 : 0.5 }}>
            {step.toUpperCase()}
          </span>
          {idx < REFERRAL_STEPS.length - 1 && (
            <div style={{
              width: '20px', height: '2px',
              backgroundColor: 'var(--c-crimson)',
              opacity: idx < currentIndex ? 0.6 : 0.2,
              transition: 'opacity 0.3s ease',
            }} />
          )}
        </div>
      ))}
    </div>
  );
};

export const CaseHistoryTimeline = ({ priorAssessments }) => {
  const { t } = useTranslation();
  const [diffView, setDiffView] = useState(false);

  if (!priorAssessments || priorAssessments.length === 0) {
    return (
      <div style={{ border: 'var(--border)', borderTop: 'none', padding: 'var(--sp-6)', textAlign: 'center' }}>
        <p className="t-mono" style={{ opacity: 0.4 }}>NO PRIOR ASSESSMENTS ON RECORD</p>
      </div>
    );
  }

  const renderLesions = (current, previous) => {
    // Only the four flat clinical counts are diffable numbers; a detector
    // that has not run reports null for its key (not zero -- "not measured"
    // and "none found" are different claims), so those render their own
    // not-measured text rather than a false "0" or a NaN diff.
    if (!current) return <p className="t-mono" style={{ opacity: 0.5 }}>NO LESION DATA</p>;
    const entries = Object.entries(current).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return <p className="t-mono" style={{ opacity: 0.5 }}>NO LESION DATA</p>;
    return (
      <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-2)' }}>
        {entries.map(([key, val]) => {
          const label = key.replace(/([A-Z])/g, ' $1').toUpperCase();
          const prevVal = previous ? previous[key] : null;
          const haveBoth = typeof val === 'number' && typeof prevVal === 'number';
          const diff = haveBoth ? val - prevVal : null;

          let diffColor = 'inherit';
          let diffText = '';
          if (diffView && previous && diff !== null) {
            if (diff > 0) { diffColor = 'var(--c-danger, #C42B2B)'; diffText = ` (+${diff})`; }
            else if (diff < 0) { diffColor = 'var(--c-success)'; diffText = ` (${diff})`; }
            else { diffText = ' (0)'; }
          }

          return (
            <div key={key} className="u-flex u-justify-between u-items-center" style={{ padding: 'var(--sp-2)', border: '1px solid var(--c-border)' }}>
              <span className="t-mono" style={{ fontSize: '12px', opacity: 0.8 }}>{label}</span>
              <span className="t-mono" style={{ fontWeight: 700, color: diffView && previous ? diffColor : 'inherit' }}>
                {typeof val === 'number' ? val : <span style={{ opacity: 0.4 }}>NOT MEASURED</span>} {diffText}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="case-history" style={{ border: 'var(--border)', borderTop: 'none', padding: 'var(--sp-4)' }}>
      <InfoBanner title={t('central.timeline.banner.title', 'PATIENT HISTORY & COMPARISON')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div><strong style={{ color: 'var(--c-crimson)' }}>DIFF VIEW:</strong> Automatically highlights changes in lesion evidence between adjacent visits. (+ / -) indicates progression or regression.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>REFERRAL STATUS:</strong> Tracks the patient's progress (Referred → Contacted → Attended), or shows Lost to Follow-up / Manual Follow-up (SMS not delivered) when the normal path did not complete.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>LESION EVIDENCE:</strong> Provides a longitudinal breakdown of specific physiological features like microaneurysms and exudates detected by the AI.</div>
        </div>
      </InfoBanner>

      <div className="u-flex u-justify-end u-items-center u-mb-4">
        <button 
          className={`btn ${diffView ? 'btn--primary' : 'btn--outline'}`}
          onClick={() => setDiffView(!diffView)}
          style={diffView ? { boxShadow: '3px 3px 0px #000' } : {}}
        >
          {diffView ? t('central.timeline.disableDiff', '◆ DIFF VIEW ON') : t('central.timeline.enableDiff', 'ENABLE DIFF VIEW')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)' }}>
        {priorAssessments.map((visit, index) => {
          const previousVisit = priorAssessments[index + 1];
          const date = new Date(visit.gradedAt);
          const grade = visit.drGradeCnn;

          return (
            <div 
              key={visit.caseId} 
              className="panel u-p-6" 
              style={{ 
                background: 'var(--bg)', 
                border: '1px solid var(--c-border)',
                position: 'relative',
              }}
            >
              <div className="u-flex u-justify-between u-items-start u-mb-4">
                <div className="u-flex u-gap-4">
                  <div style={{ 
                    width: '120px', 
                    height: '120px', 
                    border: '2px solid var(--c-crimson)', 
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-sm)',
                    flexShrink: 0,
                  }}>
                    <FundusSvg severity={grade} />
                  </div>
                  <div>
                    <div className="t-mono u-mb-1" style={{ opacity: 0.5, fontSize: 'var(--fs-tiny)' }}>
                      {t('central.timeline.visitLabel', 'VISIT')} • {date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}
                    </div>
                    <div className="t-h3 u-mb-2" style={{ fontWeight: 800 }}>{grade} / {drGradeLabels[grade] || 'UNKNOWN'}</div>
                    {visit.status && (
                      <div className={`badge ${visit.status.includes('OVERRIDDEN') ? 'badge--warning' : 'badge--pass'}`}>
                        {visit.status}
                      </div>
                    )}
                    
                    {visit.referralStatus && (
                      <div className="u-mt-4">
                        <div className="t-mono u-mb-1" style={{ fontSize: '10px', opacity: 0.5, letterSpacing: '1px' }}>{t('central.timeline.referralStatus', 'REFERRAL STATUS')}</div>
                        <ReferralTracker status={visit.referralStatus} />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 'var(--sp-4)', borderTop: '1px solid var(--c-border)', paddingTop: 'var(--sp-4)' }}>
                <div className="t-label u-mb-2">{t('central.timeline.lesionEvidence', 'LESION EVIDENCE')} {diffView && previousVisit?.lesions ? t('central.timeline.vsPrevious', '(VS PREVIOUS)') : ''}</div>
                {renderLesions(visit.lesions, previousVisit?.lesions)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
