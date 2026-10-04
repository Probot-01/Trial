import React, { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SectionCard } from './SectionCard';
import { SettingRow } from './SettingRow';
import { ToggleSwitch } from './ToggleSwitch';
import { SegmentedControl } from './SegmentedControl';
import '../../styles/settings.css';

const STORAGE_KEY = 'netrasetu_settings';


const DEFAULT_SETTINGS = {
  // 1. Language
  language: 'en',

  // 2. Display
  textSize: 'Normal', // 'Small' (12px) | 'Normal' (14px) | 'Large' (16px)
  highContrast: false,
  compactTableView: false,
  sortListsBy: 'Urgency' // 'Urgency' | 'Date' | 'PHC'
};

export const CentralSettingsPage = ({
  role: directRole,
  userProfile: directProfile,
  onLogout: directLogout,
  onClose: directClose
}) => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const outletCtx = useOutletContext() || {};

  const role = directRole || outletCtx.role || localStorage.getItem('netra_user_role') || 'ophthalmologist';
  const onLogout = directLogout || outletCtx.onLogout;
  const isOphth = role === 'ophthalmologist';

  // Load persisted settings
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.warn('Could not parse saved settings', e);
    }
    return DEFAULT_SETTINGS;
  });

  // Active section for sidebar navigation
  const [activeSection, setActiveSection] = useState('language');

  // Confirmation Modals & Dialogs state
  const [modalType, setModalType] = useState(null); // 'guide' | 'report' | 'privacy'
  const [toastMessage, setToastMessage] = useState(null);

  // Report problem local state
  const [reportIssue, setReportIssue] = useState('');

  // Show bottom toast helper
  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  };

  // Helper to update individual setting
  const updateSetting = (key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('Failed to save settings to localStorage', e);
      }
      return next;
    });
  };

  // 1. Language change effect
  const handleLanguageChange = (langCode) => {
    updateSetting('language', langCode);
    if (i18n && typeof i18n.changeLanguage === 'function') {
      i18n.changeLanguage(langCode);
    }
    localStorage.setItem('i18nextLng', langCode);
    showToast(
      langCode === 'mr' ? 'भाषा मराठीत बदलली' :
        langCode === 'hi' ? 'भाषा हिंदी में बदली गई' :
          'Language switched to English'
    );
  };

  // 2. Text size effect: live updates --fs across the app
  useEffect(() => {
    const sizeMap = {
      Small: '12px',
      Normal: '14px',
      Large: '16px'
    };
    const targetSize = sizeMap[settings.textSize] || '14px';
    document.documentElement.style.setProperty('--fs', targetSize);
  }, [settings.textSize]);

  // 3. High contrast mode effect
  useEffect(() => {
    const root = document.documentElement;
    if (settings.highContrast) {
      root.classList.add('high-contrast-mode');
    } else {
      root.classList.remove('high-contrast-mode');
    }
  }, [settings.highContrast]);

  // 4. Compact Table View persistence
  useEffect(() => {
    localStorage.setItem('netrasetu_compact_table', settings.compactTableView ? 'true' : 'false');
  }, [settings.compactTableView]);

  // Handle Close
  const handleClose = () => {
    if (directClose) {
      directClose();
      return;
    }
    // Navigate back to role's primary view
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      navigate(isOphth ? '/ophth/queue' : '/admin/dashboard');
    }
  };


  const handleReportSubmit = () => {
    const body = encodeURIComponent(reportIssue || '(describe the issue here)');
    window.open(`mailto:support@netrasetu.gov.in?subject=${encodeURIComponent('NetraSetu issue report')}&body=${body}`, '_blank');
    setModalType(null);
    setReportIssue('');
    showToast('Opening your email client with this report pre-filled.');
  };

  // Sidebar navigation click
  const handleNavClick = (sectionId) => {
    setActiveSection(sectionId);
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className={`settings-page-wrapper ${settings.highContrast ? 'high-contrast-mode' : ''}`}>
      {/* ── Full-Width Red Header Bar ────────────────────────────── */}
      <header className="settings-header">
        <div className="settings-header__inner">
          <div className="settings-header__brand">
            <h1 className="settings-header__title">Settings</h1>
            <span className="settings-header__badge">
              {isOphth ? 'CLINICAL SPEC' : 'DISTRICT WORKER'}
            </span>
          </div>
          <button
            type="button"
            className="settings-header__close-btn"
            onClick={handleClose}
            aria-label="Close Settings"
          >
            <span>Close</span>
            <span style={{ fontSize: '11px', opacity: 0.8 }}>✕</span>
          </button>
        </div>
      </header>

      {/* ── Main Container ───────────────────────────────────────── */}
      <div className="settings-container">
        <div className="settings-layout">
          {/* ── Sticky Left Sidebar (>= 1040px) ────────────────────── */}
          <aside className="settings-sidebar" aria-label="Settings Navigation">
            <div className="settings-sidebar__title">Sections</div>
            <button
              type="button"
              className={`settings-sidebar__link ${activeSection === 'language' ? 'active' : ''}`}
              onClick={() => handleNavClick('language')}
            >
              <span>1. Language</span>
              <span className="settings-sidebar__link-arrow">›</span>
            </button>
            <button
              type="button"
              className={`settings-sidebar__link ${activeSection === 'display' ? 'active' : ''}`}
              onClick={() => handleNavClick('display')}
            >
              <span>2. Display</span>
              <span className="settings-sidebar__link-arrow">›</span>
            </button>
            <button
              type="button"
              className={`settings-sidebar__link ${activeSection === 'support' ? 'active' : ''}`}
              onClick={() => handleNavClick('support')}
            >
              <span>3. Help & Support</span>
              <span className="settings-sidebar__link-arrow">›</span>
            </button>
          </aside>

          {/* ── Left Column: Language, Display ────────────────────────── */}
          <div className="settings-column">
            {/* 1. Language */}
            <SectionCard
              id="language"
              title="Language"
              icon="🌐"
              badge="I18N"
            >
              <SettingRow
                title="Application language"
                hint="Applies to menus, alerts and reports."
                fullWidth
                control={
                  <SegmentedControl
                    id="setting-lang"
                    ariaLabel="Select Application Language"
                    value={settings.language}
                    onChange={handleLanguageChange}
                    options={[
                      { value: 'en', label: 'English' },
                      { value: 'mr', label: 'मराठी' },
                      { value: 'hi', label: 'हिंदी' }
                    ]}
                  />
                }
              />
            </SectionCard>

            {/* 2. Display */}
            <SectionCard
              id="display"
              title="Display"
              icon="🖥️"
              badge="UI"
            >
              <SettingRow
                title="Text size"
                hint="Updates text scaling live across all views."
                fullWidth
                control={
                  <SegmentedControl
                    id="setting-textsize"
                    ariaLabel="Text size"
                    value={settings.textSize}
                    onChange={(val) => {
                      updateSetting('textSize', val);
                      showToast(`Text size set to ${val}`);
                    }}
                    options={[
                      { value: 'Small', label: 'Small 12px' },
                      { value: 'Normal', label: 'Normal 14px' },
                      { value: 'Large', label: 'Large 16px' }
                    ]}
                  />
                }
              />

              <SettingRow
                title="High contrast"
                hint="Easier to read in bright sunlight."
                control={
                  <ToggleSwitch
                    id="toggle-contrast"
                    ariaLabel="Toggle High contrast"
                    checked={settings.highContrast}
                    onChange={(val) => {
                      updateSetting('highContrast', val);
                      showToast(val ? 'High contrast enabled' : 'Standard contrast restored');
                    }}
                  />
                }
              />

              <SettingRow
                title="Compact table view"
                hint="Show more rows on one screen."
                control={
                  <ToggleSwitch
                    id="toggle-compact"
                    ariaLabel="Toggle Compact table view"
                    checked={settings.compactTableView}
                    onChange={(val) => {
                      updateSetting('compactTableView', val);
                      showToast(val ? 'Compact table view enabled' : 'Default row padding restored');
                    }}
                  />
                }
              />

              <SettingRow
                title="Sort lists by"
                hint="Default sorting key for review queues."
                fullWidth
                control={
                  <SegmentedControl
                    id="setting-sort"
                    ariaLabel="Sort lists by"
                    value={settings.sortListsBy}
                    onChange={(val) => {
                      updateSetting('sortListsBy', val);
                      showToast(`Default sort set to ${val}`);
                    }}
                    options={[
                      { value: 'Urgency', label: 'Urgency' },
                      { value: 'Date', label: 'Date' },
                      { value: 'PHC', label: 'PHC' }
                    ]}
                  />
                }
              />
            </SectionCard>
          </div>

          {/* ── Right Column: Help & Support ──────────────────────────── */}
          <div className="settings-column">
            {/* 3. Help & Support */}
            <SectionCard
              id="support"
              title="Help & support"
              icon="ℹ️"
              badge="GOV-AID"
            >
              <SettingRow
                title="Email support"
                hint="support@netrasetu.gov.in"
                control={
                  <a
                    href="mailto:support@netrasetu.gov.in"
                    className="settings-btn"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Email
                  </a>
                }
              />

              <SettingRow
                title="National Tele-Health Hotline"
                hint="1800-112-233 (Toll-Free, 24x7)"
                control={
                  <a
                    href="tel:1800112233"
                    className="settings-btn"
                  >
                    Call
                  </a>
                }
              />

              <SettingRow
                title="User guide & training videos"
                hint="Protocol documentation for retinal grading."
                isAction
                onClick={() => setModalType('guide')}
              />

              <SettingRow
                title="Report a problem"
                hint="Submit telemetry logs or report a bug."
                isAction
                onClick={() => setModalType('report')}
              />

              <SettingRow
                title="Privacy policy & terms"
                hint="How patient data is handled in this system."
                isAction
                onClick={() => setModalType('privacy')}
              />
            </SectionCard>
          </div>
        </div>
      </div>

      {/* ── Bottom Toast Notification ────────────────────────────── */}
      {toastMessage && (
        <div className="settings-toast" role="status" aria-live="polite">
          <span className="settings-toast__icon">✓</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ── Dialog Modals ────────────────────────────────────────── */}

      {/* User Guide Dialog */}
      {modalType === 'guide' && (
        <div className="settings-modal-backdrop" onClick={() => setModalType(null)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="settings-modal__title">📖 Clinical User Guide</h3>
            <div className="settings-modal__desc">
              <p>• <strong>DR Grading Guidelines:</strong> Adheres to ICDR 5-level scale (No DR, Mild NPDR, Moderate NPDR, Severe NPDR, PDR).</p>
              <p style={{ marginTop: '8px' }}>• <strong>AI Assist:</strong> Review Grad-CAM heatmaps for microaneurysms and exudate clusters.</p>
              <p style={{ marginTop: '8px' }}>• <strong>Training materials:</strong> distributed separately by the programme office; not hosted in this app.</p>
            </div>
            <div className="settings-modal__actions">
              <button type="button" className="settings-btn settings-btn--primary" onClick={() => setModalType(null)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report Problem Dialog — no bug-report endpoint exists, so this opens a
          real mailto: with the description filled in, instead of claiming the
          report was received somewhere. */}
      {modalType === 'report' && (
        <div className="settings-modal-backdrop" onClick={() => setModalType(null)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="settings-modal__title">🛠️ Report a Problem</h3>
            <p className="settings-modal__desc">
              Describe the issue encountered during retinal grading, synchronization, or patient record retrieval.
              This opens your email client addressed to support — nothing is sent from here directly.
            </p>
            <textarea
              className="settings-modal__input"
              rows={4}
              placeholder="e.g. Image artifacts on PHC 4 upload, sync latency..."
              value={reportIssue}
              onChange={(e) => setReportIssue(e.target.value)}
              style={{ width: '100%', resize: 'vertical' }}
            />
            <div className="settings-modal__actions">
              <button type="button" className="settings-btn" onClick={() => setModalType(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                onClick={handleReportSubmit}
              >
                Open email to support
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Privacy Policy Dialog — states what is actually true today (media at
          rest is AES-256-GCM encrypted; reviews and access are logged), not an
          unverified claim of certification against a named government scheme. */}
      {modalType === 'privacy' && (
        <div className="settings-modal-backdrop" onClick={() => setModalType(null)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="settings-modal__title">🛡️ Health Data Privacy</h3>
            <div className="settings-modal__desc">
              <p>This is a prototype system, not a certified production deployment:</p>
              <p style={{ marginTop: '8px' }}>• Stored fundus images and reports are encrypted at rest (AES-256-GCM).</p>
              <p style={{ marginTop: '8px' }}>• Every case review and every access to patient data is logged.</p>
              <p style={{ marginTop: '8px' }}>• Only public research datasets are used for demos and testing — no real patient data.</p>
            </div>
            <div className="settings-modal__actions">
              <button type="button" className="settings-btn settings-btn--primary" onClick={() => setModalType(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
