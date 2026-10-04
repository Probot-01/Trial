
import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/useSync';
import { RootStackParamList, TabParamList } from './types';
import LoginScreen from '../screens/LoginScreen';
import RegistrationScreen from '../screens/RegistrationScreen';
import QueueScreen from '../screens/QueueScreen';
import CaptureScreen from '../screens/CaptureScreen';
import LensCameraScreen from '../screens/LensCameraScreen';
import CaseReportScreen from '../screens/CaseReportScreen';
import SettingsScreen from '../screens/SettingsScreen';
import PairingScreen from '../screens/PairingScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function MainTabs() {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { pendingCount } = useSync();
  const c = theme.c;
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.crimson,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.headerBg, borderTopColor: 'rgba(196, 43, 43, 0.25)', height: 62, paddingBottom: 8 },
        tabBarLabelStyle: { fontFamily: theme.fonts.monoBold, fontSize: 10, letterSpacing: 1.2 },
      }}
    >
      <Tab.Screen
        name="Register"
        component={RegistrationScreen}
        options={{
          title: t('header.nav.register', 'New Patient').toUpperCase(),
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>＋</Text>,
        }}
      />
      <Tab.Screen
        name="Queue"
        component={QueueScreen}
        options={{
          title: t('header.nav.queue', 'Queue').toUpperCase(),
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>☰</Text>,
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          tabBarBadgeStyle: { backgroundColor: c.crimson, fontFamily: theme.fonts.monoBold, fontSize: 10 },
        }}
      />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { theme } = useTheme();
  const { session } = useAuth();
  const base = theme.mode === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <NavigationContainer
      theme={{ ...base, colors: { ...base.colors, background: theme.c.surface, primary: theme.c.crimson, card: theme.c.surface, text: theme.c.text, border: theme.c.border } }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.c.surface } }}>
        {!session ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Pairing" component={PairingScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="Capture" component={CaptureScreen} />
            <Stack.Screen name="LensCamera" component={LensCameraScreen} options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
            <Stack.Screen name="CaseReport" component={CaseReportScreen} options={{ presentation: 'modal' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Pairing" component={PairingScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
