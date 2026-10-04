import React, { useState } from 'react';


export const InfoModalButton = ({ title = 'PAGE INFO', rows = [] }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        onClick={() => setOpen(!open)}
        title={`${title} info`}
        aria-label={`${title} info`}
        style={{
          background: 'transparent',
          border: '2px solid var(--c-crimson)',
          color: 'var(--c-crimson)',
          borderRadius: '50%',
          width: '28px',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 'bold',
          fontFamily: 'serif',
          cursor: 'pointer',
          marginLeft: '4px',
          transition: 'background 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(204, 0, 0, 0.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
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
            width: '480px', maxWidth: '92vw',
            zIndex: 9999,
            backgroundColor: '#FFF8F0',
            border: '2px solid var(--c-crimson)',
            boxShadow: '12px 12px 0px rgba(0,0,0,0.18)',
            padding: 'var(--sp-5)',
            maxHeight: '80vh', overflowY: 'auto',
          }}>
            <div className="u-flex u-justify-between u-items-center u-mb-4" style={{ borderBottom: '2px solid var(--c-crimson)', paddingBottom: 'var(--sp-3)' }}>
              <h3 className="t-h3" style={{ margin: 0, color: 'var(--c-crimson)', letterSpacing: '1px' }}>{title}</h3>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '20px', color: 'var(--c-crimson)', lineHeight: 1 }}>✕</button>
            </div>
            <div className="t-mono" style={{ fontSize: '11.5px', display: 'flex', flexDirection: 'column', gap: '13px', lineHeight: '1.6' }}>
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
