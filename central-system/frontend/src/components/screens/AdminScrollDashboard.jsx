import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { centralApi } from '../../api/centralApiClient';
import { USE_MOCK_DATA } from '../../config';
import { LoadError } from '../shared/LoadError';
import { InfoModalButton } from '../shared/InfoModalButton';
import { EyeHeroSVG } from './EyeHeroSVG';
import './AdminScrollDashboard.css';

const OVERVIEW_INFO_ROWS = [
  { term: 'CASES TODAY / THIS WEEK', text: 'Cases received from all PHCs so far today, and over the last 7 days.' },
  { term: 'AVG REVIEW TIME', text: 'How long an ophthalmologist typically spends reviewing a case before confirming or overriding it.' },
  { term: 'MODEL ACCURACY / AGREEMENT RATE / AVG CONFIDENCE', text: 'How often the AI’s grade matches what an ophthalmologist confirms, how often the two grading branches agree with each other, and how certain the model reports being on average.' },
  { term: 'PHC NETWORK', text: 'How many cases each Primary Health Centre has sent today — a quick read on which clinics are active and how busy each one is.' },
  { term: 'REFERRAL FUNNEL', text: 'The patient journey from being screened, to referred, to confirmed by a specialist, to actually treated. See the Referral Tracker page for the live, case-by-case list behind this.' },
];

const CHAPTERS = [
  { id: 'hero', label: 'Overview' },
  { id: 'screening', label: 'Screening' },
  { id: 'ai', label: 'AI Performance' },
  { id: 'phc', label: 'PHC Network' },
  { id: 'referral', label: 'Referrals' },
];

// Which side each chapter's panel sits on: the eye leans the other way.
const CARD_SIDES = [-1, -1, 1, -1, 1];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// --- Animated counter ---
// The figure is written straight into its own node. Counting through React
// state meant every card setting state sixty times a second, all of it landing
// in the same frames as the scroll.
const useCountUp = (target, shouldAnimate, duration = 1400) => {
  const ref = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!shouldAnimate) { el.textContent = '0'; return undefined; }

    const cleanStr = String(target).replace(/,/g, '');
    const numericTarget = parseFloat(cleanStr);
    if (isNaN(numericTarget)) { el.textContent = String(target); return undefined; }

    const isFloat = cleanStr.includes('.');
    const decimals = isFloat ? (cleanStr.split('.')[1] || '').length : 0;
    const startTime = performance.now();
    const finalText = isFloat ? numericTarget.toFixed(decimals) : Math.round(numericTarget).toLocaleString();

    // The count-up is decoration; the number is the data. A paused
    // requestAnimationFrame (background/throttled tab) must not leave a real
    // figure on its starting "0": skip the animation while hidden, and always
    // land the true value with a timer.
    if (typeof document !== 'undefined' && document.hidden) { el.textContent = finalText; return undefined; }
    const settle = setTimeout(() => { el.textContent = finalText; }, duration + 250);

    const animate = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = numericTarget * eased;
      el.textContent = isFloat ? current.toFixed(decimals) : Math.round(current).toLocaleString();
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => { clearTimeout(settle); if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, shouldAnimate, duration]);

  return ref;
};

/**
 * A heading whose lines wipe up from behind a mask, one after another. Each
 * line is a node, so an accent span inside a line still works.
 */
const SplitTitle = React.memo(({ lines, visible, as: Tag = 'h2', className = 'admin-scroll__title' }) => (
  <Tag className={className}>
    {lines.map((line, i) => (
      <span className="admin-scroll__line" key={i}>
        <span
          className={`admin-scroll__line-in ${visible ? 'is-in' : ''}`}
          style={{ '--i': i }}
        >
          {line}
        </span>
      </span>
    ))}
  </Tag>
));

/**
 * One chapter's layer. Every card covers the whole pinned viewport, so its
 * panel holds the same place on screen for as long as the chapter lasts — the
 * page never carries it past. Arrival and departure are written onto the
 * element by the scroll engine as --enter and --exit.
 */
const Card = React.memo(({ side, cardRef, children }) => (
  <div className={`admin-scroll__card admin-scroll__card--${side}`} ref={cardRef}>
    <div className="admin-scroll__panel">{children}</div>
  </div>
));

// Live mode gets only casesToday, casesPerPhc and averageReviewTurnaroundSeconds
// from GET /admin/dashboard (api-contracts.md). Every other figure is "—" in
// live mode; the trend deltas and the referral funnel are mock-only copy.
const NA = '—';
const pct = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 10 : null);
const mockOnly = (text) => (USE_MOCK_DATA ? text : undefined);

// --- Stat card with counter ---
const StatCard = React.memo(({ label, value, suffix, delta, deltaDir, visible, index = 0 }) => {
  const animVal = useCountUp(value, visible);
  return (
    <div
      className={`admin-scroll__stat ${visible ? 'admin-scroll__stat--visible' : ''}`}
      style={{ '--i': index }}
    >
      <div className="admin-scroll__stat-label">{label}</div>
      <div className="admin-scroll__stat-value">
        <span ref={animVal} />{suffix && value !== NA && <span className="suffix">{suffix}</span>}
      </div>
      {delta && (
        <div className={`admin-scroll__stat-delta admin-scroll__stat-delta--${deltaDir || 'up'}`}>
          {delta}
        </div>
      )}
    </div>
  );
});

// --- Progress ring ---
// `value` is a percentage, or null when the API does not provide the figure:
// then the ring stays empty and reads "—".
const ProgressRing = React.memo(({ value, visible, label, index = 0 }) => {
  const r = 36;
  const circumference = 2 * Math.PI * r;
  const has = typeof value === 'number';
  const offset = visible && has ? circumference * (1 - value / 100) : circumference;
  const animVal = useCountUp(has ? value.toFixed(1) : NA, visible, 1600);

  return (
    <div
      className={`admin-scroll__stat admin-scroll__stat--ring ${visible ? 'admin-scroll__stat--visible' : ''}`}
      style={{ '--i': index }}
    >
      <div className="admin-scroll__ring">
        <svg viewBox="0 0 80 80">
          <circle className="admin-scroll__ring-bg" cx="40" cy="40" r={r} />
          <circle
            className="admin-scroll__ring-fill"
            cx="40" cy="40" r={r}
            style={{
              '--ring-circumference': circumference,
              '--ring-offset': offset,
              strokeDasharray: circumference,
              strokeDashoffset: offset,
            }}
          />
        </svg>
        <div className="admin-scroll__ring-value"><span ref={animVal} />{has ? '%' : ''}</div>
      </div>
      <div className="admin-scroll__stat-label">{label}</div>
    </div>
  );
});

// ===== MAIN COMPONENT =====
export const AdminScrollDashboard = () => {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Arriving from the sign-in journey (a tall, scrolled page) would otherwise
  // drop the visitor into the middle of this story. This has to be instant and
  // before paint: the document sets scroll-behavior: smooth, which would
  // otherwise play the whole way back up as an animation.
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, []);

  // Scroll state
  const containerRef = useRef(null);
  const cardRefs = useRef([]);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [activeChapter, setActiveChapter] = useState(0);
  const [chapterProgress, setChapterProgress] = useState(0);
  const [visibleChapters, setVisibleChapters] = useState(new Set([0]));

  // Where the eye is looking, and where it is being asked to look. Both live
  // in refs: gaze is written straight to the DOM every frame, so following the
  // cursor costs nothing in renders.
  const pointerRef = useRef({ x: 0, y: 0 });

  // Load data
  useEffect(() => {
    centralApi.getAdminDashboard().then(d => setData(d)).catch(err => setLoadError(err));
  }, []);

  // ── Scroll engine ─────────────────────────────────────────────────
  // One rAF loop damps the raw scroll position, derives a velocity signal, and
  // hands every chapter its own arrival and departure. All of it goes out as
  // custom properties, so the scene animates at display rate rather than
  // stepping along with React renders.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = performance.now();
    let smooth = 0;
    let prev = 0;
    let vel = 0;
    let publishedProgress = -1;
    let publishedChapter = -1;
    let publishedVisible = '';
    let lean = 0;
    let gazeX = 0;
    let gazeY = 0;
    const shown = [];

    const frame = (now) => {
      const dt = Math.min(0.064, (now - last) / 1000) || 0.016;
      last = now;

      const rect = container.getBoundingClientRect();
      const total = Math.max(1, container.scrollHeight - window.innerHeight);
      const raw = clamp(-rect.top / total, 0, 1);

      // Critically damped follow: direct enough to feel attached to the wheel,
      // slow enough to iron out its steps.
      smooth += (raw - smooth) * (reduced ? 1 : 1 - Math.exp(-dt / 0.105));

      const instant = (smooth - prev) / dt;
      prev = smooth;
      const targetVel = reduced ? 0 : clamp(instant * 1.7, -1, 1);
      vel += (targetVel - vel) * (1 - Math.exp(-dt / 0.14));

      container.style.setProperty('--p', smooth.toFixed(4));
      container.style.setProperty('--vel', vel.toFixed(4));
      container.style.setProperty('--vel-abs', Math.abs(vel).toFixed(4));
      container.style.setProperty('--eye-zoom', (1 + 0.24 * smoothstep(0, 0.85, smooth)).toFixed(4));
      container.style.setProperty('--field-strength', (0.55 + smooth * 0.45).toFixed(3));

      // Each chapter owns one fifth of the scroll. u runs 0 → 1 across its
      // share: it arrives over the first sixth, holds, then leaves over the
      // last, handing straight to the next chapter with no gap between them.
      const count = CHAPTERS.length;
      // Guarded: a NaN here would index past the chapter list and blank the page.
      const idx = clamp(Math.floor(smooth * count) || 0, 0, count - 1);
      let key = '';
      let topSide = 0;
      let topWeight = 0;
      const nowVisible = new Set();

      cardRefs.current.forEach((el, i) => {
        if (!el) return;
        const u = smooth * count - i;
        // The first chapter has no run-up and the last has no way out.
        // The windows overlap, so one chapter is still leaving as the next
        // arrives and the handover reads as a dissolve, not a cut.
        const enter = i === 0 ? 1 : smoothstep(-0.16, 0.10, u);
        const exit = i === count - 1 ? 0 : smoothstep(0.82, 1, u);
        const live = u > -0.2 && exit < 0.99;

        el.style.setProperty('--enter', enter.toFixed(4));
        el.style.setProperty('--exit', exit.toFixed(4));
        el.style.setProperty('--u', clamp(u - 0.5, -0.6, 0.6).toFixed(4));
        if (shown[i] !== live) {
          shown[i] = live;
          el.style.visibility = live ? 'visible' : 'hidden';
        }
        // Whichever card is most present decides which way the eye leans. A
        // weighted average would leave it parked in the middle — under the
        // text — for the whole of a handover; this way it commits to a side
        // and the CSS easing carries it across.
        const weight = enter * (1 - exit);
        if (weight > topWeight) {
          topWeight = weight;
          topSide = CARD_SIDES[i];
        }

        if (live && enter > 0.12 && exit < 0.7) {
          nowVisible.add(i);
          key += i;
        }
      });

      // The eye keeps out of the panel's way: the cards alternate sides, so it
      // drifts across the stage as the story moves between them.
      // The lean is sprung, not switched: the eye drifts across as the story
      // changes sides instead of arriving with a transition after the fact.
      lean += (-topSide - lean) * (reduced ? 1 : 1 - Math.exp(-dt / 0.42));
      container.style.setProperty('--eye-x', lean.toFixed(4));

      // Gaze: the cursor, plus a pull towards the panel the eye is leaning
      // away from — it keeps looking at what you are reading.
      const p = pointerRef.current;
      const wantX = clamp(p.x, -1, 1) * 9 - lean * 4.5;
      const wantY = clamp(p.y, -1, 1) * 5.5;
      const g = reduced ? 1 : 1 - Math.exp(-dt / 0.16);
      gazeX += (wantX - gazeX) * g;
      gazeY += (wantY - gazeY) * g;
      container.style.setProperty('--gaze-x', gazeX.toFixed(3));
      container.style.setProperty('--gaze-y', gazeY.toFixed(3));

      // React state changes only when it has to.
      if (idx !== publishedChapter) {
        publishedChapter = idx;
        setActiveChapter(idx);
      }

      const quantised = Math.round(smooth * 250) / 250;
      if (quantised !== publishedProgress) {
        publishedProgress = quantised;
        setScrollProgress(quantised);
        setChapterProgress(clamp(quantised * count - idx, 0, 1));
      }

      if (key !== publishedVisible) {
        publishedVisible = key;
        setVisibleChapters(nowVisible);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The app header is sticky, so the pinned stage has to start below it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const header = document.querySelector('.app-header');
      container.style.setProperty('--header-h', (header ? header.offsetHeight : 64) + 'px');
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Pointer tracking — straight into a ref; the engine reads it each frame.
  useEffect(() => {
    const onMove = (e) => {
      pointerRef.current = {
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: (e.clientY / window.innerHeight) * 2 - 1,
      };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const scrollToChapter = useCallback((idx) => {
    const container = containerRef.current;
    if (!container) return;
    const totalHeight = container.scrollHeight - window.innerHeight;
    // Aim at the middle of the chapter's share, where its card is fully open.
    const targetScroll = container.offsetTop + ((idx + 0.45) / CHAPTERS.length) * totalHeight;
    window.scrollTo({ top: targetScroll, behavior: 'smooth' });
  }, []);

  const today = useMemo(() => {
    return new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }, []);

  // Straight from the response (mock mode: mockAdminDashboard). A field the
  // response does not carry is shown as "—", never as a stand-in number.
  const stats = useMemo(() => ({
    casesToday: data?.casesToday ?? NA,
    thisWeek: data?.casesThisWeek ?? NA,
    totalProcessed: data?.totalCasesProcessed != null ? data.totalCasesProcessed.toLocaleString() : NA,
    avgReviewTime: data?.averageReviewTurnaroundSeconds ?? NA,
    modelAccuracy: pct(data?.modelAccuracy),
    overrideRate: pct(data?.overrideRate),
    avgConfidence: pct(data?.avgConfidenceScore),
    imagesRejected: data?.imagesRejectedQuality ?? NA,
  }), [data]);

  const phcs = useMemo(() => data?.casesPerPhc ?? [], [data]);

  const maxPhcCount = useMemo(() => Math.max(...phcs.map(p => p.count), 1), [phcs]);

  // The readout that trails the story along the foot of the screen.
  const telemetry = useMemo(() => ([
    { k: 'CASES', v: stats.casesToday },
    { k: 'ACCURACY', v: stats.modelAccuracy != null ? stats.modelAccuracy + '%' : NA },
    { k: 'ACTIVE CENTRES', v: phcs.length },
    { k: 'THIS WEEK', v: stats.thisWeek },
  ]), [stats, phcs]);

  const setCard = (i) => (el) => { cardRefs.current[i] = el; };

  const active = CHAPTERS[activeChapter] || CHAPTERS[0];

  return (
    <div className="admin-scroll" ref={containerRef}>
      {/* Corner decorations */}
      <div className="admin-scroll__corner admin-scroll__corner--tl" />
      <div className="admin-scroll__corner admin-scroll__corner--tr" />
      <div className="admin-scroll__corner admin-scroll__corner--bl" />
      <div className="admin-scroll__corner admin-scroll__corner--br" />

      {/* Chapter navigation dots */}
      <nav className="admin-scroll__nav" aria-label="Chapter navigation">
        <span className="admin-scroll__nav-track" aria-hidden="true">
          <span className="admin-scroll__nav-fill" />
        </span>
        {CHAPTERS.map((ch, i) => (
          <button
            key={ch.id}
            className={`admin-scroll__nav-dot ${activeChapter === i ? 'admin-scroll__nav-dot--active' : ''}`}
            onClick={() => scrollToChapter(i)}
            aria-label={`Go to ${ch.label}`}
          >
            <span className="admin-scroll__nav-label">{ch.label}</span>
            <span className="admin-scroll__nav-pip" />
          </button>
        ))}
      </nav>

      {/* ═══ PINNED STAGE — the eye, and the chapter cards over it ═══ */}
      <div className="admin-scroll__viewport">
        {/* Light drifting through the vitreous, with the choroidal vessels
            showing through out of focus behind it. */}
        <div className="admin-scroll__field" aria-hidden="true" />

        <EyeHeroSVG
          progress={scrollProgress}
          chapter={activeChapter}
          chapterProgress={chapterProgress}
        />

        {/* A scan passes over the scene on every chapter change. */}
        <div className="admin-scroll__sweep" key={'s' + activeChapter} aria-hidden="true" />

        {/* ── Chapter 01: OVERVIEW ── */}
        <Card side="left" cardRef={setCard(0)}>
          <div className="admin-scroll__eyebrow u-flex u-items-center u-gap-2">
            <span>District Report</span>
            <InfoModalButton title="DISTRICT OVERVIEW" rows={OVERVIEW_INFO_ROWS} />
          </div>
          <SplitTitle
            as="h1"
            className="admin-scroll__title admin-scroll__hero-title"
            visible={visibleChapters.has(0)}
            lines={['DISTRICT', <><span className="accent">OVER</span>VIEW</>]}
          />
          <p className="admin-scroll__hero-date">{today}</p>
          <p className="admin-scroll__subtitle" style={{ marginTop: '1.5rem' }}>
            A comprehensive look at the DR screening program across all Primary Health Centres in your district.
          </p>
          {loadError && (
            <div style={{ marginTop: '1rem' }}>
              <LoadError error={loadError} what="the district dashboard" compact />
            </div>
          )}
          <div className="admin-scroll__cue" aria-hidden="true">
            <span className="admin-scroll__cue-rail"><span /></span>
            SCROLL
          </div>
        </Card>

        {/* ── Chapter 02: SCREENING IMPACT ── */}
        <Card side="left" cardRef={setCard(1)}>
          <div className="admin-scroll__eyebrow">Screening Impact</div>
          <SplitTitle lines={['Cases', 'Processed']} visible={visibleChapters.has(1)} />
          <p className="admin-scroll__subtitle">
            Real-time screening throughput across all connected PHCs.
          </p>
          <div className="admin-scroll__stats admin-scroll__stats--col">
            <StatCard index={0} label="CASES TODAY" value={stats.casesToday} delta={mockOnly('+12% from yesterday')} deltaDir="up" visible={visibleChapters.has(1)} />
            <StatCard index={1} label="THIS WEEK" value={stats.thisWeek} delta={mockOnly('+8% WoW')} deltaDir="up" visible={visibleChapters.has(1)} />
            <StatCard index={2} label="TOTAL PROCESSED" value={stats.totalProcessed} visible={visibleChapters.has(1)} />
            <StatCard index={3} label="AVG REVIEW TIME" value={stats.avgReviewTime} suffix="s" delta={mockOnly('-3s from last week')} deltaDir="up" visible={visibleChapters.has(1)} />
          </div>
        </Card>

        {/* ── Chapter 03: AI PERFORMANCE ── */}
        <Card side="right" cardRef={setCard(2)}>
          <div className="admin-scroll__eyebrow">AI Performance</div>
          <SplitTitle lines={['Model', 'Accuracy']} visible={visibleChapters.has(2)} />
          <p className="admin-scroll__subtitle">
            Deep learning model diagnostics and confidence metrics for the CNN grading engine.
          </p>
          <div className="admin-scroll__rings">
            <ProgressRing index={0} value={stats.modelAccuracy} visible={visibleChapters.has(2)} label="MODEL ACCURACY" />
            <ProgressRing index={1} value={stats.overrideRate != null ? 100 - stats.overrideRate : null} visible={visibleChapters.has(2)} label="AGREEMENT RATE" />
            <ProgressRing index={2} value={stats.avgConfidence} visible={visibleChapters.has(2)} label="AVG CONFIDENCE" />
          </div>
        </Card>

        {/* ── Chapter 04: PHC NETWORK ── */}
        <Card side="left" cardRef={setCard(3)}>
          <div className="admin-scroll__eyebrow">PHC Network</div>
          <SplitTitle lines={['Health', 'Centres']} visible={visibleChapters.has(3)} />
          <p className="admin-scroll__subtitle">
            Per-centre case distribution and screening workload.
          </p>
          <div className="admin-scroll__phc-grid">
            {data && phcs.length === 0 && (
              <p className="admin-scroll__subtitle">No cases from any PHC today.</p>
            )}
            {phcs.map((phc, i) => (
              <div
                key={phc.phcId ?? 'unattributed'}
                className={`admin-scroll__phc ${visibleChapters.has(3) ? 'admin-scroll__phc--visible' : ''}`}
                style={{ '--i': i }}
              >
                <div className="admin-scroll__phc-name">{(phc.phcName || 'Unattributed').replace('PHC ', '')}</div>
                <div className="admin-scroll__phc-count">{phc.count}</div>
                <div className="admin-scroll__phc-bar">
                  <div
                    className="admin-scroll__phc-bar-fill"
                    style={{ '--bar-width': `${(phc.count / maxPhcCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Chapter 05: REFERRAL PIPELINE ── */}
        <Card side="right" cardRef={setCard(4)}>
          <div className="admin-scroll__eyebrow">Referral Pipeline</div>
          <SplitTitle lines={['Referral', 'Funnel']} visible={visibleChapters.has(4)} />
          <p className="admin-scroll__subtitle">
            Patient journey from AI screening to specialist confirmation and treatment.
          </p>
          {!USE_MOCK_DATA && (
            <p className="admin-scroll__subtitle">
              Funnel figures are not provided by the central API yet; see Referrals for the live list.
            </p>
          )}
          <div className="admin-scroll__funnel">
            {(USE_MOCK_DATA ? [
              { label: 'SCREENED', value: 1284, width: '100%' },
              { label: 'REFERRED', value: 312, width: '24%' },
              { label: 'CONFIRMED', value: 287, width: '22%' },
              { label: 'TREATED', value: 198, width: '15%' },
            ] : []).map((step, i) => (
              <div
                key={step.label}
                className={`admin-scroll__funnel-step ${visibleChapters.has(4) ? 'admin-scroll__funnel-step--visible' : ''}`}
                style={{ '--i': i }}
              >
                <div className="admin-scroll__funnel-label">{step.label}</div>
                <div className="admin-scroll__funnel-bar" style={{ '--funnel-width': step.width }}>
                  <span className="admin-scroll__funnel-bar-val">{step.value.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ═══ SCROLL TRACK — height only; it is what the story plays along ═══ */}
      <div className="admin-scroll__track" aria-hidden="true">
        {CHAPTERS.map((ch) => (
          <div className="admin-scroll__chapter" key={ch.id} />
        ))}
      </div>

      {/* ═══ TELEMETRY FOOT ═══ */}
      <div className="admin-scroll__telemetry" aria-hidden="true">
        <div className="admin-scroll__telemetry-bar"><span /></div>
        <div className="admin-scroll__telemetry-row">
          <span className="admin-scroll__telemetry-chapter">
            {active.label.toUpperCase()}
          </span>
          <span className="admin-scroll__telemetry-items">
            {telemetry.map((item) => (
              <span key={item.k} className="admin-scroll__telemetry-item">
                {item.k}<b>{item.v}</b>
              </span>
            ))}
          </span>
          <span className="admin-scroll__telemetry-live">{USE_MOCK_DATA ? 'DEMO' : 'LIVE'}</span>
        </div>
      </div>
    </div>
  );
};
