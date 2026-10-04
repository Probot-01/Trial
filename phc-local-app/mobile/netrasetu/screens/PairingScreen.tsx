
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useNavigation } from '@react-navigation/native';
import { makeStyles } from '../theme/ThemeContext';
import { AppHeader } from '../components/AppHeader';
import { Btn, Field, Input, Notice } from '../components/ui';
import { useToast } from '../components/Toast';
import { clearPairing, getPairing, parsePairing, savePairing, Pairing } from '../peer/pairing';
import { hello } from '../peer/peerClient';
import { syncManager } from '../sync/syncManager';
import { useSync } from '../sync/useSync';
import { formatAgo } from '../lib/format';

export default function PairingScreen() {
  const s = useStyles();
  const toast = useToast();
  const sync = useSync();
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Pairing | null | undefined>(undefined);

  React.useEffect(() => { getPairing().then(setCurrent); }, []);

  const tryPair = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setScanning(false);
    const previous = await getPairing();
    try {
      const p = parsePairing(text);
      await savePairing(p);
      await hello();
      setCurrent(p);
      toast(`Paired with the PHC PC (${p.phcName ?? p.phcCode}).`, 'success');
      syncManager.trigger();
    } catch (e) {
      if (previous) await savePairing(previous); else await clearPairing();
      toast(`Pairing failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      <AppHeader onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>PHC PC LINK</Text>

        {current ? (
          <Notice tone={sync.pcLink === 'linked' ? 'success' : 'warning'} title={`PAIRED · ${sync.pcLink.toUpperCase()}`}>
            <Text style={s.body}>PC {current.pcDeviceId} · this phone {current.deviceId}</Text>
            <Text style={s.body}>Last synced with the PC: {formatAgo(sync.pcLastSyncAt)}</Text>
            {sync.pcError ? <Text style={[s.body, { color: '#A82222' }]}>{sync.pcError}</Text> : null}
          </Notice>
        ) : (
          <Notice title="NOT PAIRED">
            On the PHC PC run: npm run peer -- pair "Phone name" (in phc-local-app/backend), then scan the code it prints.
          </Notice>
        )}

        {scanning ? (
          <View style={s.scanner}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={busy ? undefined : ({ data }) => tryPair(data)}
            />
          </View>
        ) : null}

        <View style={{ gap: 10, marginTop: 16 }}>
          {!scanning ? (
            <Btn
              size="lg"
              label={current ? 'RE-PAIR: SCAN NEW CODE' : 'SCAN PAIRING CODE'}
              loading={busy}
              onPress={async () => {
                if (!permission?.granted && !(await requestPermission()).granted) { toast('Camera permission is needed to scan the code.'); return; }
                setScanning(true);
              }}
            />
          ) : (
            <Btn variant="outline" label="CANCEL SCAN" onPress={() => setScanning(false)} />
          )}
          <Field label="OR PASTE THE PAIRING CODE" hint="The JSON text the PC printed under the QR code.">
            <Input value={pasted} onChangeText={setPasted} multiline autoCapitalize="none" autoCorrect={false} placeholder='{"kind":"netrasetu-pair",…}' />
          </Field>
          <Btn variant="outline" label="PAIR WITH PASTED CODE" disabled={!pasted.trim()} loading={busy} onPress={() => tryPair(pasted)} />
          {current ? (
            <Btn variant="ghost" label="UNPAIR THIS PHONE" onPress={async () => { await clearPairing(); setCurrent(null); syncManager.trigger(); toast('Unpaired.', 'info'); }} />
          ) : null}
        </View>

        <Text style={s.caption}>
          Everything sent between this phone and the PC is encrypted (AES-256-GCM) with the key inside the code.
          Keep the code private; revoke a lost phone on the PC with npm run peer -- revoke &lt;deviceId&gt;.
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  scroll: { padding: 16, paddingBottom: 48, gap: 12 },
  h1: { fontFamily: t.fonts.heavy, fontSize: 24, color: t.c.text, letterSpacing: -0.5 },
  body: { fontFamily: t.fonts.mono, fontSize: 11, color: t.c.text, lineHeight: 17 },
  scanner: { height: 320, borderWidth: 2, borderColor: t.c.crimson, overflow: 'hidden' },
  caption: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.textMuted, lineHeight: 15, marginTop: 16 },
}));
