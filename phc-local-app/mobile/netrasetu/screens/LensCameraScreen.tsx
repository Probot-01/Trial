
import React, { useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line } from 'react-native-svg';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { makeStyles } from '../theme/ThemeContext';
import { Btn } from '../components/ui';
import { useToast } from '../components/Toast';
import { RootStackParamList } from '../navigation/types';

const ZOOM_STEP = 0.05;

export default function LensCameraScreen() {
  const s = useStyles();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { patientId } = useRoute<RouteProp<RootStackParamList, 'LensCamera'>>().params;
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [focusKey, setFocusKey] = useState<'on' | 'off'>('on');
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<{ uri: string; width: number; height: number; takenAt: string } | null>(null);

  if (!permission) return <View style={s.root} />;
  if (!permission.granted) {
    return (
      <SafeAreaView style={[s.root, s.center]}>
        <Text style={s.permTitle}>CAMERA ACCESS NEEDED</Text>
        <Text style={s.permText}>The fundus lens uses this phone's main camera to photograph the retina.</Text>
        <Btn label="ALLOW CAMERA" onPress={requestPermission} style={{ marginTop: 16, alignSelf: 'stretch' }} />
        <Btn variant="ghost" label="CANCEL" onPress={() => navigation.goBack()} style={{ alignSelf: 'stretch' }} />
      </SafeAreaView>
    );
  }

  // Re-running autofocus: switching the mode off and on makes the camera refocus.
  const refocus = () => {
    setFocusKey('off');
    setTimeout(() => setFocusKey('on'), 80);
  };

  const takePhoto = async () => {
    if (!cam.current || !ready || busy) return;
    setBusy(true);
    try {
      const p = await cam.current.takePictureAsync({ quality: 1, exif: false, skipProcessing: false, shutterSound: false });
      if (!p?.uri) throw new Error('The camera returned no image.');
      setShot({ uri: p.uri, width: p.width, height: p.height, takenAt: new Date().toISOString() });
    } catch (e) {
      toast(`Capture failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const acceptPhoto = () => {
    if (!shot) return;
    navigation.navigate({ name: 'Capture', params: { patientId, lensPhoto: shot }, merge: true });
  };

  if (shot) {
    return (
      <SafeAreaView style={s.root}>
        <Text style={s.topTitle}>REVIEW LENS CAPTURE</Text>
        <Image source={{ uri: shot.uri }} style={s.review} resizeMode="contain" />
        <Text style={s.caption}>{shot.width}×{shot.height} px · the quality gate runs on the next screen</Text>
        <View style={s.reviewActions}>
          <Btn variant="outline" label="↺ RETAKE" onPress={() => setShot(null)} style={{ flex: 1 }} />
          <Btn variant="success" label="USE THIS IMAGE →" onPress={acceptPhoto} style={{ flex: 1.4 }} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={s.root}>
      <CameraView
        ref={cam}
        style={{ flex: 1 }}
        facing="back"
        enableTorch={torch}
        zoom={zoom}
        autofocus={focusKey}
        animateShutter={false}
        onCameraReady={() => setReady(true)}
        onMountError={(e) => toast(`Camera unavailable: ${e.message}`)}
      />

      {/* Guide: pupil circle, crosshair, macula target. Tap anywhere to refocus. */}
      <Pressable style={s.overlay} onPress={refocus} accessibilityLabel="Tap to refocus">
        <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
          <Circle cx={50} cy={50} r={34} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={0.5} fill="none" />
          <Circle cx={50} cy={50} r={34} stroke="#C42B2B" strokeOpacity={0.9} strokeWidth={0.4} strokeDasharray="2 2" fill="none" />
          <Line x1={50} y1={44} x2={50} y2={56} stroke="#FFFFFF" strokeOpacity={0.6} strokeWidth={0.3} />
          <Line x1={44} y1={50} x2={56} y2={50} stroke="#FFFFFF" strokeOpacity={0.6} strokeWidth={0.3} />
          <Circle cx={50} cy={50} r={3} stroke="#FFFFFF" strokeOpacity={0.6} strokeWidth={0.3} fill="none" />
        </Svg>
      </Pressable>

      <SafeAreaView style={s.chrome} pointerEvents="box-none">
        <View style={s.topBar}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={12}><Text style={s.topBtn}>✕ CANCEL</Text></Pressable>
          <Text style={s.topTitle}>FUNDUS LENS</Text>
          <Pressable onPress={() => setTorch((v) => !v)} hitSlop={12} accessibilityRole="switch" accessibilityState={{ checked: torch }}>
            <Text style={[s.topBtn, torch && s.on]}>{torch ? '● LIGHT ON' : '○ LIGHT OFF'}</Text>
          </Pressable>
        </View>
        <Text style={s.hint}>Optic disc inside the circle · dim room · tap the preview to refocus</Text>

        <View style={s.bottom}>
          <View style={s.zoomRow}>
            <Pressable style={s.zoomBtn} onPress={() => setZoom((z) => Math.max(0, +(z - ZOOM_STEP).toFixed(2)))}><Text style={s.zoomText}>−</Text></Pressable>
            <Text style={s.zoomVal}>ZOOM {Math.round(zoom * 100)}%</Text>
            <Pressable style={s.zoomBtn} onPress={() => setZoom((z) => Math.min(1, +(z + ZOOM_STEP).toFixed(2)))}><Text style={s.zoomText}>+</Text></Pressable>
          </View>
          <Pressable
            style={[s.shutter, (!ready || busy) && { opacity: 0.5 }]}
            onPress={takePhoto}
            disabled={!ready || busy}
            accessibilityRole="button"
            accessibilityLabel="Capture retinal image"
          >
            <View style={s.shutterInner} />
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: '#000000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.c.surface },
  permTitle: { fontFamily: t.fonts.monoBold, fontSize: 13, letterSpacing: 1.4, color: t.c.crimson },
  permText: { fontFamily: t.fonts.body, fontSize: 14, color: t.c.text, textAlign: 'center', marginTop: 8 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  chrome: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
  topBtn: { fontFamily: t.fonts.monoBold, fontSize: 11, color: '#FFFFFF', letterSpacing: 1 },
  on: { color: '#F2C27A' },
  topTitle: { fontFamily: t.fonts.monoBold, fontSize: 12, letterSpacing: 2, color: '#FFFFFF', textAlign: 'center', marginVertical: 8 },
  hint: { fontFamily: t.fonts.mono, fontSize: 10, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginTop: 4 },
  bottom: { alignItems: 'center', paddingBottom: 24, gap: 16 },
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(0,0,0,0.5)', padding: 6 },
  zoomBtn: { width: 44, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  zoomText: { color: '#FFFFFF', fontFamily: t.fonts.monoBold, fontSize: 18 },
  zoomVal: { color: '#FFFFFF', fontFamily: t.fonts.monoBold, fontSize: 11, minWidth: 80, textAlign: 'center' },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#C42B2B' },
  review: { flex: 1, backgroundColor: '#000000' },
  caption: { fontFamily: t.fonts.mono, fontSize: 10, color: 'rgba(255,255,255,0.7)', textAlign: 'center', marginVertical: 8 },
  reviewActions: { flexDirection: 'row', gap: 10, padding: 16 },
}));
