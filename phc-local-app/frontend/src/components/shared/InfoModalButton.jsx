import React, { useState } from 'react';

/**
 * InfoModalButton -- the small circular "i" next to a screen title, and the
 * modal it opens. Same pattern as central-system/frontend's version (kept as
 * a separate copy since the two frontends are independent apps with no
 * shared package), so a technician gets the same explain-this-screen affordance
 * an ophthalmologist already has on Cases.
 *
 * `rows` is an array of { term, text } pairs, rendered as a definition list.
 */
export const InfoModalButton = ({ title = 'SCREEN INFO', rows = [] }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={`${title} info`}
        aria-label={`${title} info`}
        style={{
          background: 'transparent',
          border: '2px solid var(--c-crimson)',
          color: 'var(--c-crimson)',
          borderRadius: '50%',
          width: '26px',
          height: '26px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '13px',
          fontWeight: 'bold',
          fontFamily: 'serif',
          cursor: 'pointer',
          marginLeft: '4px',
          flexShrink: 0,
        }}
      >
        i
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.4)' }}
          />
          <div style={{
            position: 'fixed',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '440px', maxWidth: '92vw',
            zIndex: 9999,
            backgroundColor: '#FFF8F0',
            border: '2px solid var(--c-crimson)',
            boxShadow: '10px 10px 0px rgba(0,0,0,0.18)',
            padding: '20px',
            maxHeight: '80vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '2px solid var(--c-crimson)', paddingBottom: '10px' }}>
              <h3 className="t-mono" style={{ margin: 0, color: 'var(--c-crimson)', letterSpacing: '1px', fontSize: '15px', fontWeight: 800 }}>{title}</h3>
              <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '18px', color: 'var(--c-crimson)', lineHeight: 1 }}>✕</button>
            </div>
            <div className="t-mono" style={{ fontSize: '11.5px', display: 'flex', flexDirection: 'column', gap: '12px', lineHeight: '1.6' }}>
              {rows.map(({ term, text }) => (
                <div key={term}><strong style={{ color: 'var(--c-crimson)' }}>{term}:</strong> {text}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
