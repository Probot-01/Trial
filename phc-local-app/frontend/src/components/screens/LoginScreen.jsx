import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RetinalWaveCanvas } from '../shared/RetinalWaveCanvas';
import { USE_MOCK_DATA } from '../../config';
import { localApi } from '../../api/localApiClient';

export const LoginScreen = ({ onLogin }) => {
  const { t } = useTranslation();
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Technician credentials
  // The demo pair is prefilled only in mock mode. Against the real backend the
  // account is one created on this PC (`npm run technician -- add ...`), so nothing
  // is prefilled and no password is printed on screen.
  const [username, setUsername] = useState(USE_MOCK_DATA ? 'krrish' : '');
  const [password, setPassword] = useState(USE_MOCK_DATA ? 'tech123' : '');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError(t('login.auth.errorEmpty', 'Please enter both username and password.'));
      return;
    }

    setLoading(true);
    setError(null);

    // Real backend: technician accounts on this PHC PC (phc-local-app/backend,
    // `npm run technician -- add ...`), checked against their scrypt hash.
    if (!USE_MOCK_DATA) {
      try {
        const session = await localApi.login(username.trim(), password);
        setIsTransitioning(true);
        setTimeout(() => onLogin && onLogin({
          authenticated: true,
          // The role the SERVER issued, not a constant. This used to be the
          // literal 'technician' with the real role read only to pick a
          // display label, so the app could not tell an admin from a
          // technician -- and admin-only actions (revoking a paired phone)
          // had no way to know whether to offer themselves. The backend is
          // still the authority: requireTechnician.admin rejects a
          // non-admin whatever the UI shows.
          role: session.user.role,
          username: session.user.username,
          name: session.user.name,
          roleTitle: session.user.role === 'phc_admin' ? 'PHC Admin' : 'PHC Technician',
          token: session.token,
          expiresAt: session.expiresAt,
        }), 400);
      } catch (err) {
        setError(err.message || t('login.auth.errorInvalid', 'INVALID CREDENTIALS.'));
        setLoading(false);
      }
      return;
    }

    // Mock mode (demo without a backend): unchanged.
    setTimeout(() => {
      if (
        (username.toLowerCase() === 'krrish' && password === 'tech123') ||
        (username.toLowerCase() === 'technician' && password === 'tech123') ||
        password.length >= 4
      ) {
        setIsTransitioning(true);
        setTimeout(() => {
          if (onLogin) {
            onLogin({
              authenticated: true,
              // Mock mode has no server to ask, so it is a plain technician:
              // the lower privilege, never an admin the demo did not grant.
              // 'technician' and 'phc_admin' are the backend's own two values
              // (scripts/technician.js); this must not invent a third.
              role: 'technician',
              username: username.trim(),
              name: username.toLowerCase().includes('krrish') ? 'Krrish Gadekar' : username.trim(),
              roleTitle: 'PHC Technician',
              phc: 'PHC Kharadi'
            });
          }
        }, 400);
      } else {
        setError(t('login.auth.errorInvalid', 'INVALID CREDENTIALS. USE DEMO: krrish / tech123'));
        setLoading(false);
      }
    }, 400);
  };

  return (
    <div className="login-screen">
      <RetinalWaveCanvas />

      <div className="login-screen__content" style={{ position: 'relative', zIndex: 1 }}>
        {/* Top Header branding */}
        <div
          className={`login-hero ${isTransitioning ? 'login-hero--exit' : ''}`}
          style={{ marginBottom: 'var(--sp-6)' }}
        >
          <div className="login-hero__eyecon">
            <svg viewBox="0 0 120 120" width="100" height="100">
              <circle cx="60" cy="60" r="50" fill="none" stroke="var(--c-crimson)" strokeWidth="1" opacity="0.3" />
              <circle cx="60" cy="60" r="35" fill="none" stroke="var(--c-black)" strokeWidth="1.5" opacity="0.5" />
              <circle cx="60" cy="60" r="18" fill="var(--c-black)" opacity="0.9" />
              <circle cx="60" cy="60" r="6" fill="var(--c-crimson)" />
              {/* Retinal vessels */}
              <path d="M60 42 Q50 30 35 25" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.8" opacity="0.6" />
              <path d="M60 42 Q70 30 85 25" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.8" opacity="0.6" />
              <path d="M60 78 Q50 90 35 95" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.8" opacity="0.6" />
              <path d="M60 78 Q70 90 85 95" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.8" opacity="0.6" />
              <path d="M42 60 Q30 50 25 35" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.6" opacity="0.4" />
              <path d="M78 60 Q90 50 95 35" fill="none" stroke="var(--c-crimson-dark)" strokeWidth="0.6" opacity="0.4" />
            </svg>
          </div>

          <h1 className="login-brand__title">
            NETRA<span className="login-brand__accent">SETU</span>
          </h1>
          <p className="login-brand__tagline">
            {t('login.subtitle', 'EXPLAINABLE AI FOR DIABETIC RETINOPATHY')}
          </p>
        </div>

        {/* Single Technician Auth Card */}
        <div className={`login-auth-container ${isTransitioning ? 'login-auth-container--exit' : ''}`}>
          <div className="login-auth-topbar">
            <span style={{ fontWeight: 600 }}>
              {/* This app has only ever offered the one technician login -- the
                  interpolated role name used to be a hardcoded English literal,
                  so it stayed 'PHC TECHNICIAN' even once the rest of the screen
                  was in Hindi/Marathi. Use the same translated title the
                  (currently unused) role-select copy already carries. */}
              {t('login.auth.authenticatingAs', 'AUTHENTICATING AS: {{role}}', {
                role: t('login.roles.technician.title', 'PHC TECHNICIAN'),
              })}
            </span>
          </div>

          <div className="login-auth-box">
            <form onSubmit={handleSubmit}>
              {error && (
                <div className="login-auth-error">
                  <span>⚠</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="login-auth-field">
                <label className="login-auth-label">{t('login.auth.username', 'USERNAME')}</label>
                <input
                  type="text"
                  className="login-auth-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                />
              </div>

              <div className="login-auth-field">
                <label className="login-auth-label">{t('login.auth.password', 'PASSWORD')}</label>
                <input
                  type="password"
                  className="login-auth-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>

              <button
                type="submit"
                className="login-auth-submit"
                disabled={loading}
              >
                {loading ? t('login.auth.authenticating', 'AUTHENTICATING...') : t('login.auth.initiate', 'INITIATE SESSION ✦')}
              </button>

              {USE_MOCK_DATA && (
                <div className="login-auth-hint">
                  {t('login.auth.demo', 'DEMO CREDENTIALS:')}{' '}
                  <span style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>krrish</span> /{' '}
                  <span style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>tech123</span>
                </div>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginScreen;
