
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { SelectField } from './SelectField';
import { makeStyles } from '../theme/ThemeContext';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parse(v: string): { d: string; m: string; y: string } {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v || '');
  if (!match) return { d: '', m: '', y: '' };
  const [, d, m, y] = match;
  return { d: String(Number(d)), m: String(Number(m)), y };
}

function daysInMonth(m: string, y: string): number {
  if (!m) return 31;
  const year = y ? Number(y) : 2000; // a leap year default, so 29 Feb stays offered while the year is still unset
  return new Date(year, Number(m), 0).getDate();
}

export function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useStyles();
  const { d, m, y } = parse(value);
  const maxYear = new Date().getFullYear();

  const dayOptions = useMemo(() => {
    const n = daysInMonth(m, y);
    return Array.from({ length: n }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
  }, [m, y]);
  const monthOptions = useMemo(
    () => MONTHS.map((label, i) => ({ value: String(i + 1), label })),
    [],
  );
  const yearOptions = useMemo(
    () => Array.from({ length: 121 }, (_, i) => String(maxYear - i)).map((yr) => ({ value: yr, label: yr })),
    [maxYear],
  );

  const emit = (nd: string, nm: string, ny: string) => {
    if (!nd || !nm || !ny) { onChange(''); return; }
    // A day that doesn't exist in the newly chosen month (e.g. 31 -> Feb) clamps
    // down rather than silently keeping an invalid date.
    const clampedDay = Math.min(Number(nd), daysInMonth(nm, ny));
    onChange(`${String(clampedDay).padStart(2, '0')}/${nm.padStart(2, '0')}/${ny}`);
  };

  return (
    <View style={s.row}>
      <View style={s.day}>
        <SelectField title="DAY" value={d} placeholder="Day" options={dayOptions} onChange={(v) => emit(v, m, y)} />
      </View>
      <View style={s.month}>
        <SelectField title="MONTH" value={m} placeholder="Month" options={monthOptions} onChange={(v) => emit(d, v, y)} />
      </View>
      <View style={s.year}>
        <SelectField title="YEAR" value={y} placeholder="Year" options={yearOptions} onChange={(v) => emit(d, m, v)} />
      </View>
    </View>
  );
}

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', gap: 6 },
  day: { flex: 1 },
  month: { flex: 1.6 },
  year: { flex: 1.1 },
}));
