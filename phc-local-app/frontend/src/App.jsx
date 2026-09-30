import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginScreen } from './components/screens/LoginScreen';
import { AppLayout } from './components/layout/AppLayout';
import { PatientRegistrationForm } from './components/screens/PatientRegistrationForm';
import { CaptureScreen } from './components/screens/CaptureScreen';
import { LocalQueueTable } from './components/screens/LocalQueueTable';
import { PairedDevicesPage } from './components/screens/PairedDevicesPage';
import { DemoDataBanner } from './components/shared/DemoDataBanner';
import { USE_MOCK_DATA } from './config';
import { localApi } from './api/localApiClient';

function readSavedAuth() {
  const saved = localStorage.getItem('netra_phc_auth');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.authenticated) {
        return parsed;
      }
    } catch (err) {
      console.warn('Failed to parse saved technician session', err);
    }
  }
  return null;
}

function App() {
  const [auth, setAuth] = useState(readSavedAuth);
  // A saved token from a previous visit might have expired, or the backend's
  // accounts might have been reset since -- trusting it on sight used to render
  // the registration form for a beat before the first real API call 401'd and
  // bounced to login. Confirm it with GET /auth/me first; mock mode has no
  // backend to ask, so it keeps the old instant-trust behaviour.
  const [checkingSession, setCheckingSession] = useState(() => !USE_MOCK_DATA && !!auth);

  useEffect(() => {
    if (!checkingSession) return;
    let cancelled = false;
    localApi.getMe()
      .then(() => { if (!cancelled) setCheckingSession(false); })
      .catch(() => {
        // _request's own 401 handling already cleared localStorage and is
        // navigating to '/'; just stop trusting this session in the meantime
        // so nothing authed renders while that lands.
        if (!cancelled) { setAuth(null); setCheckingSession(false); }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = (authPayload) => {
    localStorage.setItem('netra_phc_auth', JSON.stringify(authPayload));
    setAuth(authPayload);
  };

  const handleLogout = () => {
    localStorage.removeItem('netra_phc_auth');
    setAuth(null);
  };

  if (checkingSession) {
    // Deliberately blank rather than the login screen or the registration
    // form -- this is a beat, not a state anyone should act on either way.
    return null;
  }

  return (
    <BrowserRouter>
      <DemoDataBanner />
      <Routes>
        {/* Landing Page: Authentication Screen */}
        <Route
          path="/"
          element={
            !auth ? (
              <LoginScreen onLogin={handleLogin} />
            ) : (
              <Navigate to="/register" replace />
            )
          }
        />

        {/* Protected Technician Routes */}
        <Route
          element={
            auth ? (
              <AppLayout auth={auth} onLogout={handleLogout} />
            ) : (
              <Navigate to="/" replace />
            )
          }
        >
          <Route path="/register" element={<PatientRegistrationForm />} />
          <Route path="/capture" element={<CaptureScreen />} />
          <Route path="/queue" element={<LocalQueueTable />} />
          {/* Who can replicate patient records with this PC, and how to cut
              one off. auth carries the role the SERVER issued, so the screen
              can hide an admin-only action; the backend still enforces it. */}
          <Route path="/devices" element={<PairedDevicesPage auth={auth} />} />
        </Route>

        {/* Fallback to landing / dashboard */}
        <Route path="*" element={<Navigate to={auth ? "/register" : "/"} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
