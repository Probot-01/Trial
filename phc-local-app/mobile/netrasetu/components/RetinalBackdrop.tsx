
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg';
import { useTheme } from '../theme/ThemeContext';

export function RetinalBackdrop() {
  const { theme } = useTheme();
  const c = theme.c;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={c.crimson} stopOpacity={0.18} />
            <Stop offset="50%" stopColor={c.crimson} stopOpacity={0.06} />
            <Stop offset="100%" stopColor={c.crimson} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={500} cy={500} r={450} fill="url(#glow)" />
        {[
          'M100,500 Q300,300 500,500 T900,500',
          'M150,400 Q350,600 550,400 T950,400',
          'M50,600 Q250,400 450,600 T850,600',
        ].map((d) => <Path key={d} d={d} stroke={c.crimson} strokeOpacity={0.12} strokeWidth={1} fill="none" />)}
        {[
          'M200,200 Q400,400 500,500 Q600,600 800,800',
          'M300,100 Q450,450 500,500 Q550,550 700,900',
          'M100,800 Q300,600 500,500 Q700,400 900,200',
        ].map((d) => <Path key={d} d={d} stroke={c.crimsonDark} strokeOpacity={0.14} strokeWidth={1.5} fill="none" />)}
        <Circle cx={300} cy={480} r={40} fill="none" stroke={c.black} strokeOpacity={0.3} strokeDasharray="4 4" />
        <Circle cx={650} cy={500} r={20} fill="none" stroke={c.black} strokeOpacity={0.2} />
        <Circle cx={840} cy={800} r={16} fill="none" stroke={c.crimson} strokeOpacity={0.3} />
        <Circle cx={840} cy={800} r={10} fill="none" stroke={c.black} strokeOpacity={0.5} />
        <Circle cx={840} cy={800} r={5} fill={c.black} fillOpacity={0.8} />
        <Circle cx={840} cy={800} r={2} fill={c.crimson} />
      </Svg>
    </View>
  );
}

/** The login screen's eye mark (desktop LoginScreen .login-hero__eyecon). */
export function EyeMark({ size = 96 }: { size?: number }) {
  const { theme } = useTheme();
  const c = theme.c;
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120">
      <Circle cx={60} cy={60} r={50} fill="none" stroke={c.crimson} strokeWidth={1} strokeOpacity={0.3} />
      <Circle cx={60} cy={60} r={35} fill="none" stroke={c.black} strokeWidth={1.5} strokeOpacity={0.5} />
      <Circle cx={60} cy={60} r={18} fill={c.black} fillOpacity={0.9} />
      <Circle cx={60} cy={60} r={6} fill={c.crimson} />
      {['M60 42 Q50 30 35 25', 'M60 42 Q70 30 85 25', 'M60 78 Q50 90 35 95', 'M60 78 Q70 90 85 95'].map((d) => (
        <Path key={d} d={d} fill="none" stroke={c.crimsonDark} strokeWidth={0.8} strokeOpacity={0.6} />
      ))}
      {['M42 60 Q30 50 25 35', 'M78 60 Q90 50 95 35'].map((d) => (
        <Path key={d} d={d} fill="none" stroke={c.crimsonDark} strokeWidth={0.6} strokeOpacity={0.4} />
      ))}
    </Svg>
  );
}
