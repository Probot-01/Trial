
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { makeStyles } from '../theme/ThemeContext';
import { AppHeader } from '../components/AppHeader';
import { Btn, Field, Input, Notice, SectionHeader } from '../components/ui';
import { useToast } from '../components/Toast';
import { AppConfig, CONFIG_KV_KEY, DEFAULT_CONFIG, getConfig, setConfig } from '../config';
import { kvSet } from '../db/database';
import { secretSet } from '../lib/secrets';
import { checkHealth } from '../api/central';
import { syncManager } from '../sync/syncManager';
import { storagePressure } from '../lib/storage';
import { formatBytes } from '../lib/format';

export default function SettingsScreen() {
  const s = useStyles();
  const toast = useToast();
  const navigation = useNavigation();
  const [draft, setDraft] = useState<AppConfig>(getConfig());
  const [testing, setTesting] = useState(false);
  const set = (k: keyof AppConfig, v: string) => setDraft((d) => ({ ...d, [k]: v.trim() }));

  const test = async () => {
    const previous = getConfig();
    setTesting(true);
    setConfig({ centralUrl: draft.centralUrl });
    const ok = await checkHealth();
    setConfig(previous);
    setTesting(false);
    toast(ok ? 'Central server reachable.' : `No response from ${draft.centralUrl}/health.`, ok ? 'success' : 'error');
  };

  const save = async () => {
    if (!/^https?:\/\/\S+$/.test(draft.centralUrl)) { toast('Server address must start with http:// or https://'); return; }
    if (!/^[A-Za-z0-9]{2,16}$/.test(draft.phcCode)) { toast('Site code: 2–16 letters or digits.'); return; }
    setConfig(draft);
    // The API key goes to the OS keystore; the rest of the config is not secret.
    const { phcApiKey, ...rest } = getConfig();
    await kvSet(CONFIG_KV_KEY, JSON.stringify(rest));
    await secretSet('phc_api_key', phcApiKey || null);
    syncManager.trigger();
    toast('Settings saved.', 'success');
    navigation.goBack();
  };

  const storage = storagePressure();

  return (
    <View style={s.root}>
      <AppHeader onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>DEVICE SETTINGS</Text>

        <SectionHeader badge="01" title="CENTRAL SERVER" />
        <Field label="SERVER ADDRESS" required hint="e.g. http://192.168.1.20:5000 — the central backend, not the PHC PC.">
          <Input value={draft.centralUrl} onChangeText={(v) => set('centralUrl', v)} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        </Field>
        <Field label="PHC API KEY" hint="Issued by `npm run provision-phc-key` on central. Sent as X-PHC-Api-Key.">
          <Input value={draft.phcApiKey} onChangeText={(v) => set('phcApiKey', v)} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="phc_…" />
        </Field>
        <Btn variant="outline" label={testing ? 'TESTING…' : 'TEST CONNECTION'} loading={testing} onPress={test} />

        <SectionHeader badge="02" title="THIS SITE" />
        <Field label="SITE CODE" required hint="Prefix of every patient and capture ID minted on this phone. Must be unique per PHC.">
          <Input value={draft.phcCode} onChangeText={(v) => set('phcCode', v.toUpperCase())} autoCapitalize="characters" maxLength={16} />
        </Field>
        <Field label="PHC NAME">
          <Input value={draft.phcName} onChangeText={(v) => setDraft((d) => ({ ...d, phcName: v }))} />
        </Field>
        {draft.phcCode !== getConfig().phcCode ? (
          <Notice tone="warning" title="SITE CODE CHANGE">
            Only new IDs use the new code; existing patients keep theirs. Two sites sharing a code can mint colliding IDs.
          </Notice>
        ) : null}

        <SectionHeader badge="03" title="DEVICE" />
        <View style={s.kv}><Text style={s.k}>FREE STORAGE</Text><Text style={s.v}>{formatBytes(Number.isFinite(storage.availableBytes) ? storage.availableBytes : null)}</Text></View>
        <View style={s.kv}><Text style={s.k}>DEFAULT SERVER</Text><Text style={s.v}>{DEFAULT_CONFIG.centralUrl || '(not set in build)'}</Text></View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
          <Btn variant="outline" label="RESET TO DEFAULTS" onPress={() => setDraft({ ...DEFAULT_CONFIG })} style={{ flex: 1 }} />
          <Btn label="SAVE" onPress={save} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  scroll: { padding: 16, paddingBottom: 48 },
  h1: { fontFamily: t.fonts.heavy, fontSize: 24, color: t.c.text, letterSpacing: -0.5 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.c.grid },
  k: { fontFamily: t.fonts.monoBold, fontSize: 10, letterSpacing: 1, color: t.c.textMuted },
  v: { fontFamily: t.fonts.mono, fontSize: 11, color: t.c.text },
}));
