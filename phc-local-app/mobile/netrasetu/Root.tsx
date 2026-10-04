
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import i18n from './i18n';
import { FONT_MAP } from './theme/fonts';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import AppNavigator from './navigation/AppNavigator';
import { getDb, kvGet } from './db/database';
import { CONFIG_KV_KEY, setConfig } from './config';
import { secretGet } from './lib/secrets';
import { syncManager } from './sync/syncManager';

interface Boot { contrast: 'light' | 'dark' }

async function boot(): Promise<Boot> {
  await getDb();
  const saved = await kvGet(CONFIG_KV_KEY);
  if (saved) {
    const { phcApiKey: legacyKey, ...rest } = JSON.parse(saved); // older builds kept the key here
    setConfig(rest);
    if (legacyKey) setConfig({ phcApiKey: legacyKey });
  }
  const storedKey = await secretGet('phc_api_key');
  if (storedKey) setConfig({ phcApiKey: storedKey });
  const lang = await kvGet('lang');
  if (lang) await i18n.changeLanguage(lang);
  const contrast = (await kvGet('contrast')) === 'dark' ? 'dark' : 'light';
  return { contrast };
}

function SyncStarter() {
  const { session } = useAuth();
  useEffect(() => {
    if (session) syncManager.start();
    else syncManager.stop();
  }, [session]);
  return null;
}

function Shell() {
  const { theme } = useTheme();
  const { ready } = useAuth();
  if (!ready) return <Splash />;
  return (
    <>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <ToastProvider>
        <SyncStarter />
        <AppNavigator />
      </ToastProvider>
    </>
  );
}

function Splash({ error }: { error?: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#FAF6EF', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {error ? (
        <Text style={{ color: '#A82222', textAlign: 'center' }}>Could not start: {error}</Text>
      ) : (
        <ActivityIndicator color="#C42B2B" />
      )}
    </View>
  );
}

export default function Root() {
  const [fontsLoaded, fontError] = useFonts(FONT_MAP);
  const [booted, setBooted] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    boot().then(setBooted).catch((e) => setBootError(String(e?.message ?? e)));
  }, []);

  if (bootError) return <Splash error={bootError} />;
  if ((!fontsLoaded && !fontError) || !booted) return <Splash />;

  return (
    <SafeAreaProvider>
      <ThemeProvider initialMode={booted.contrast}>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
