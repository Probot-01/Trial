import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { USE_MOCK_DATA } from '../../config';
import { LoadError } from '../shared/LoadError';
import { InfoModalButton } from '../shared/InfoModalButton';

const DASHBOARD_INFO_ROWS = [
  { term: 'CASES TODAY / THIS WEEK', text: 'Cases received from all PHCs so far today, and over the last 7 days.' },
  { term: 'TOTAL PROCESSED', text: 'All cases this server has ever graded, across every PHC.' },
  { term: 'AVG REVIEW TIME', text: 'How long an ophthalmologist typically spends reviewing a case before confirming or overriding it.' },
  { term: 'MODEL ACCURACY / OVERRIDE RATE / AVG. CONFIDENCE', text: 'How often the AI’s grade matches what an ophthalmologist confirms, how often it gets overridden, and how certain the model reports being on average. A rising override rate is worth investigating even if it is still a small percentage.' },
  { term: 'IMAGES REJECTED (QUALITY)', text: 'Images the quality gate at a PHC sent back for a retake instead of grading — blur, poor lighting, glare, and similar capture problems.' },
  { term: 'DR GRADE DISTRIBUTION', text: 'How many screened cases fell into each severity grade, 0 (No DR) through 4 (Proliferative DR).' },
];
import { Chart, registerables } from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';

Chart.register(...registerables);

// Custom chart defaults for our theme
Chart.defaults.color = '#E61A3C';
Chart.defaults.borderColor = 'rgba(0, 0, 0, 0.15)';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;

// 3-State Sort Header Component (Matching Reference Image 2)
const SortHeader = React.memo(({ label, field, sortKey, sortDir, onSort, alignRight = false }) => {
  const isSorted = sortKey === field && sortDir !== 'none';
  return (
    <th
      className={`th-sortable ${alignRight ? 'u-text-right' : ''}`}
      onClick={() => onSort(field)}
      title={`Sort by ${label} (Current: ${isSorted ? sortDir.toUpperCase() : 'DEFAULT'})`}
    >
      <span className="th-sort-inner" style={alignRight ? { justifyContent: 'flex-end' } : {}}>
        <span>{label}</span>
        <span className={`th-sort-icon ${isSorted ? 'th-sort-icon--active' : ''}`}>
          {sortKey === field && sortDir === 'asc'
            ? '↑'
            : sortKey === field && sortDir === 'desc'
              ? '↓'
              : '⇅'}
        </span>
      </span>
    </th>
  );
});
SortHeader.displayName = 'SortHeader';

// Animated number counter hook
const useCountUp = (target, duration = 1200) => {
  const [display, setDisplay] = useState('0');
  const rafRef = useRef(null);

  useEffect(() => {
    // Parse numeric value from string (handles "1,234" and "92.1")
    const cleanStr = String(target).replace(/,/g, '');
    const numericTarget = parseFloat(cleanStr);
    if (isNaN(numericTarget)) {
      setDisplay(String(target));
      return;
    }

    const isFloat = cleanStr.includes('.');
    const decimals = isFloat ? (cleanStr.split('.')[1] || '').length : 0;
    const startTime = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = numericTarget * eased;

      if (isFloat) {
        setDisplay(current.toFixed(decimals));
      } else {
        setDisplay(Math.round(current).toLocaleString());
      }

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    const finalText = isFloat ? numericTarget.toFixed(decimals) : Math.round(numericTarget).toLocaleString();

    if (typeof document !== 'undefined' && document.hidden) {
      setDisplay(finalText);
      return undefined;
    }
    const settle = setTimeout(() => setDisplay(finalText), duration + 250);

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      clearTimeout(settle);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return display;
};


const NA = '—';
const orNA = (v) => (v === null || v === undefined ? NA : v);
const pctOrNA = (v) => (typeof v === 'number' ? (v * 100).toFixed(1) : NA);
const mockOnly = (text) => (USE_MOCK_DATA ? text : undefined);

const NotFromApi = ({ what }) => (
  <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', color: 'var(--c-text-muted)', margin: 0 }}>
    {what} is not provided by the central API yet (only in DEMO DATA mode).
  </p>
);

const StatCard = React.memo(({ label, value, delta, suffix = '' }) => {
  const animatedValue = useCountUp(value, 1000);
  const numeric = !isNaN(parseFloat(String(value).replace(/,/g, '')));
  return (
    <div className="stat hash-fill">
      <div className="stat-shimmer" />
      <div className="stat__label">{label}</div>
      <div className="stat__value">{animatedValue}{numeric ? suffix : ''}</div>
      {delta && <div className="stat__delta" style={{ color: delta.startsWith('+') || delta.startsWith('-') ? (delta.startsWith('+') ? 'var(--c-success)' : 'var(--c-warning)') : 'var(--c-text-muted)' }}>{delta}</div>}
    </div>
  );
});
StatCard.displayName = 'StatCard';

const PALETTE = ['#14B8A6', '#EAB308', '#F97316', '#A82222', '#7F1D1D'];

export const DashboardPage = () => {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 3-State Sorting for Grade Breakdown Table
  const [gradeSort, setGradeSort] = useState({ key: null, direction: 'none' });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    centralApi.getAdminDashboard().then(d => {
      if (active) {
        setData(d);
        setLoading(false);
      }
    }).catch(err => {
      if (active) {
        setLoadError(err);
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, [reloadKey]);

  const handleGradeSort = useCallback((field) => {
    setGradeSort(prev => {
      if (prev.key !== field) {
        return { key: field, direction: 'asc' };
      }
      if (prev.direction === 'asc') {
        return { key: field, direction: 'desc' };
      }
      if (prev.direction === 'desc') {
        return { key: null, direction: 'none' };
      }
      return { key: field, direction: 'asc' };
    });
  }, []);

  const gradeChartData = useMemo(() => {
    if (!data?.drGradeDistribution) {
      return { labels: [], datasets: [{ data: [], backgroundColor: PALETTE, borderWidth: 0 }] };
    }
    return {
      labels: data.drGradeDistribution.map(d => d.label),
      datasets: [{
        data: data.drGradeDistribution.map(d => d.count),
        backgroundColor: PALETTE,
        borderWidth: 0,
        hoverOffset: 6,
      }],
    };
  }, [data]);

  const weeklyChartData = useMemo(() => {
    if (!data?.weeklyTrend) {
      return { labels: [], datasets: [] };
    }
    return {
      labels: data.weeklyTrend.map(w => w.week),
      datasets: [
        {
          label: t('central.dashboard.charts.casesScreened', 'Cases Screened'),
          data: data.weeklyTrend.map(w => w.cases),
          borderColor: '#E61A3C',
          backgroundColor: 'rgba(230, 26, 60, 0.1)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#E61A3C',
          pointBorderColor: '#000',
          pointRadius: 4,
        },
        {
          label: t('central.dashboard.charts.referrals', 'Referrals'),
          data: data.weeklyTrend.map(w => w.referrals),
          borderColor: '#FF8800',
          backgroundColor: 'rgba(255, 136, 0, 0.1)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#FF8800',
          pointBorderColor: '#000',
          pointRadius: 4,
        },
      ],
    };
  }, [data]);

  const phcBarData = useMemo(() => {
    if (!data?.casesPerPhc) {
      return { labels: [], datasets: [] };
    }
    return {
      // phcName is null for the bucket of cases that arrived without a phcId.
      labels: data.casesPerPhc.map(p => (p.phcName || 'Unattributed').replace('PHC ', '')),
      datasets: [{
        label: t('central.dashboard.charts.casesToday', 'Cases Today'),
        data: data.casesPerPhc.map(p => p.count),
        backgroundColor: data.casesPerPhc.map((_, i) =>
          `rgba(230, 26, 60, ${0.5 + i * 0.15})`
        ),
        borderWidth: 0,
      }],
    };
  }, [data]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: 'rgba(22, 0, 0, 0.75)' },
      },
      y: {
        grid: { display: false },
        ticks: { color: 'rgba(22, 0, 0, 0.75)' },
      },
    },
  }), []);

  const donutOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    cutout: '72%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: 'rgba(22, 0, 0, 0.85)',
          font: { family: "'JetBrains Mono', monospace", size: 10, weight: 600 },
          padding: 12,
          usePointStyle: true,
          pointStyle: 'rect',
        },
      },
      tooltip: {
        backgroundColor: 'rgba(26, 16, 8, 0.95)',
        titleFont: { family: "'JetBrains Mono', monospace", size: 12 },
        bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
        padding: 10,
        borderColor: '#A82222',
        borderWidth: 1,
        displayColors: true,
        callbacks: {
          label: (context) => {
            const gradeItem = data?.drGradeDistribution[context.dataIndex];
            return ` ${context.label}: ${context.raw} ${t('central.dashboard.charts.cases', 'cases')} (${gradeItem ? gradeItem.percentage : 0}%)`;
          },
        },
      },
    },
  }), [data]);

  const sortedGrades = useMemo(() => {
    if (!data?.drGradeDistribution) return [];
    if (gradeSort.direction === 'none' || !gradeSort.key) {
      return data.drGradeDistribution;
    }

    return [...data.drGradeDistribution].sort((a, b) => {
      let valA = a[gradeSort.key];
      let valB = b[gradeSort.key];

      if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = valB.toLowerCase();
      }

      if (valA < valB) return gradeSort.direction === 'asc' ? -1 : 1;
      if (valA > valB) return gradeSort.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [data, gradeSort]);

  if (loadError) {
    return (
      <div className="section">
        <LoadError error={loadError} what="the district dashboard" onRetry={() => setReloadKey(k => k + 1)} />
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '300px', marginBottom: 'var(--sp-6)' }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-4)' }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: '120px' }} />)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-4)', marginTop: 'var(--sp-6)' }}>
          <div className="skeleton" style={{ height: '350px' }} />
          <div className="skeleton" style={{ height: '350px' }} />
        </div>
      </div>
    );
  }

  const totalCases = data.drGradeDistribution
    ? data.drGradeDistribution.reduce((sum, d) => sum + d.count, 0).toLocaleString()
    : NA;

  return (
    <div className="section">
      <div className="u-flex u-items-center u-justify-between u-mb-6">
        <div>
          <p className="section__subtitle">{t('central.dashboard.subtitle', 'DISTRICT WORKER')}</p>
          <div className="u-flex u-items-center u-gap-3">
            <h1 className="section__title" style={{ marginBottom: 0 }}>{t('central.dashboard.title', 'DASHBOARD')}</h1>
            <InfoModalButton title="DASHBOARD" rows={DASHBOARD_INFO_ROWS} />
          </div>
        </div>
        <span className="t-mono" style={{ opacity: 0.7 }}>
          {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
      </div>

      {/* Stat Cards — Bento Grid Row 1: Operational & Processing */}
      <div className="bento u-mb-4">
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.casesToday', 'CASES TODAY')} value={orNA(data.casesToday)} delta={mockOnly('+12% from yesterday')} />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.thisWeek', 'THIS WEEK')} value={orNA(data.casesThisWeek)} delta={mockOnly('+8% WoW')} />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.totalProcessed', 'TOTAL PROCESSED')} value={data.totalCasesProcessed != null ? data.totalCasesProcessed.toLocaleString() : NA} />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.avgReviewTime', 'AVG REVIEW TIME')} value={orNA(data.averageReviewTurnaroundSeconds)} suffix="s" delta={mockOnly('-3s from last week')} />
        </div>
      </div>

      {/* Stat Cards — Bento Grid Row 2: AI Quality & Model Reliability */}
      <div className="bento u-mb-6">
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.modelAccuracy', 'MODEL ACCURACY')} value={pctOrNA(data.modelAccuracy)} suffix="%" />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.overrideRate', 'OVERRIDE RATE')} value={pctOrNA(data.overrideRate)} suffix="%" delta="Target: < 10%" />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.imagesRejected', 'IMAGES REJECTED (QUALITY)')} value={orNA(data.imagesRejectedQuality)} delta={mockOnly('2.9% rate (-0.4%)')} />
        </div>
        <div className="bento--span-3">
          <StatCard label={t('central.dashboard.stats.avgConfidence', 'AVG. CONFIDENCE SCORE')} value={pctOrNA(data.avgConfidenceScore)} suffix="%" delta={mockOnly('High reliability tier')} />
        </div>
      </div>

      {/* Charts */}
      <div className="dashboard-charts-grid">
        {/* Weekly Trend */}
        <div className="chart-container" style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
          <h3 className="t-h3 u-mb-4">{t('central.dashboard.charts.weeklyTrend', 'WEEKLY SCREENING TREND')}</h3>
          {!data.weeklyTrend && <NotFromApi what="The weekly trend" />}
          <div style={{ height: '280px' }}>
            <Line data={weeklyChartData} options={{
              ...chartOptions,
              plugins: {
                ...chartOptions.plugins,
                legend: { display: true, labels: { color: 'rgba(22,0,0,0.8)', font: { family: "'JetBrains Mono'", size: 10 } } },
              },
            }} />
          </div>
        </div>

        {/* PHC Distribution */}
        <div className="chart-container" style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
          <h3 className="t-h3 u-mb-4">{t('central.dashboard.charts.casesByPhc', 'CASES BY PHC')}</h3>
          <div style={{ height: '280px' }}>
            <Bar data={phcBarData} options={chartOptions} />
          </div>
        </div>
      </div>

      {/* DR Grade Distribution — Upgraded Donut Chart with Center KPI */}
      <div className="dashboard-breakdown-grid">
        <div className="chart-container" style={{ border: 'var(--border)', padding: 'var(--sp-6)', position: 'relative' }}>
          <h3 className="t-h3 u-mb-4">{t('central.dashboard.charts.drGradeDist', 'DR GRADE DISTRIBUTION')}</h3>
          {!data.drGradeDistribution && <NotFromApi what="The grade distribution" />}
          <div style={{ height: '270px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Doughnut data={gradeChartData} options={donutOptions} />
            {/* Center cutout KPI overlay */}
            <div
              style={{
                position: 'absolute',
                top: '40%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontFamily: 'var(--f-display)', fontSize: '1.5rem', fontWeight: 900, color: 'var(--c-crimson)', lineHeight: 1 }}>
                {totalCases}
              </div>
              <div style={{ fontFamily: 'var(--f-mono)', fontSize: '9px', letterSpacing: '0.12em', color: 'var(--c-text-muted)', fontWeight: 700, marginTop: '2px' }}>
                {t('central.dashboard.charts.totalCases', 'TOTAL CASES')}
              </div>
            </div>
          </div>
        </div>

        {/* Grade breakdown table with 3-state sorting */}
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <SortHeader
                  label={t('central.dashboard.table.grade', 'GRADE')}
                  field="grade"
                  sortKey={gradeSort.key}
                  sortDir={gradeSort.direction}
                  onSort={handleGradeSort}
                />
                <SortHeader
                  label={t('central.dashboard.table.classification', 'CLASSIFICATION')}
                  field="label"
                  sortKey={gradeSort.key}
                  sortDir={gradeSort.direction}
                  onSort={handleGradeSort}
                />
                <SortHeader
                  label={t('central.dashboard.table.count', 'COUNT')}
                  field="count"
                  sortKey={gradeSort.key}
                  sortDir={gradeSort.direction}
                  onSort={handleGradeSort}
                  alignRight={true}
                />
                <SortHeader
                  label={t('central.dashboard.table.percentage', 'PERCENTAGE')}
                  field="percentage"
                  sortKey={gradeSort.key}
                  sortDir={gradeSort.direction}
                  onSort={handleGradeSort}
                  alignRight={true}
                />
                <th>{t('central.dashboard.table.distribution', 'DISTRIBUTION')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedGrades.map(d => (
                <tr key={d.grade}>
                  <td className="t-mono" style={{ fontWeight: 700 }}>{t('central.dashboard.table.gradeVal', 'Grade')} {d.grade}</td>
                  <td className="t-mono">{d.label}</td>
                  <td className="t-mono u-text-right" style={{ fontWeight: 700 }}>{d.count.toLocaleString()}</td>
                  <td className="t-mono u-text-right">{d.percentage}%</td>
                  <td>
                    <div className="bar" style={{ width: '100%' }}>
                      <div className="bar__fill" style={{
                        width: `${d.percentage}%`,
                        background: PALETTE[d.grade],
                      }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
