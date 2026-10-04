import React, { useEffect } from 'react';
import { USE_MOCK_DATA } from '../../config';

const BANNER_H = 32;


export const DemoDataBanner = () => {
  useEffect(() => {
    if (!USE_MOCK_DATA) return undefined;
    document.documentElement.classList.add('demo-data-mode');
    return () => document.documentElement.classList.remove('demo-data-mode');
  }, []);

  if (!USE_MOCK_DATA) return null;

  return (
    <>
      <style>{`
        html.demo-data-mode body { padding-top: ${BANNER_H}px; }
        html.demo-data-mode .app-header { top: ${BANNER_H}px; }
      `}</style>
      <div
        role="alert"
        aria-live="polite"
        data-testid="demo-data-banner"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: BANNER_H,
          zIndex: 2147483647,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'repeating-linear-gradient(-45deg, #FFD400 0 18px, #1A1008 18px 36px)',
          borderBottom: '2px solid #1A1008',
          pointerEvents: 'none',
        }}
      >
        <span style={{
          background: '#FFD400', color: '#1A1008', padding: '3px 14px',
          border: '2px solid #1A1008',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontWeight: 800, fontSize: 13, letterSpacing: '1.5px', whiteSpace: 'nowrap',
        }}>
          DEMO DATA — not real results
        </span>
      </div>
    </>
  );
};
