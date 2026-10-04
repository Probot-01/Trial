
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, ImageSourcePropType, PanResponder, Pressable, Text, View } from 'react-native';
import { makeStyles } from '../theme/ThemeContext';

const MIN = 0.5;
const MAX = 4;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));

export function ImageViewer({ source, height = 300, overlay, brackets = true }: {
  source: ImageSourcePropType;
  height?: number;
  overlay?: ImageSourcePropType | null;
  brackets?: boolean;
}) {
  const s = useStyles();
  const [zoom, setZoom] = useState(1);
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const panOffset = useRef({ x: 0, y: 0 });
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const zoomRef = useRef(1);
  const lastTap = useRef(0);
  zoomRef.current = zoom;

  const src = typeof source === 'object' && source && 'uri' in source ? (source as { uri: string }).uri : source;
  useEffect(() => { reset(); }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    setZoom(1);
    panOffset.current = { x: 0, y: 0 };
    pan.setValue({ x: 0, y: 0 });
  }

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4 || g.numberActiveTouches === 2,
    onPanResponderGrant: () => {
      const now = Date.now();
      if (now - lastTap.current < 280) {
        if (Math.abs(zoomRef.current - 1) > 0.05) reset(); else setZoom(1.6);
      }
      lastTap.current = now;
    },
    onPanResponderMove: (e, g) => {
      const touches = e.nativeEvent.touches;
      if (touches.length === 2) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const dist = Math.hypot(dx, dy);
        if (!pinchStart.current) pinchStart.current = { dist, zoom: zoomRef.current };
        setZoom(clamp(pinchStart.current.zoom * (dist / pinchStart.current.dist)));
        return;
      }
      pan.setValue({ x: panOffset.current.x + g.dx, y: panOffset.current.y + g.dy });
    },
    onPanResponderRelease: (_, g) => {
      if (!pinchStart.current) {
        panOffset.current = { x: panOffset.current.x + g.dx, y: panOffset.current.y + g.dy };
      }
      pinchStart.current = null;
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const isDefault = Math.abs(zoom - 1) < 0.01 && panOffset.current.x === 0 && panOffset.current.y === 0;

  return (
    <View style={[s.frame, { height }]} {...responder.panHandlers}>
      <Animated.View style={[s.fill, { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: zoom }] }]}>
        <Image source={source} style={s.fill} resizeMode="contain" accessibilityLabel="Retinal fundus image" />
        {overlay ? <Image source={overlay} style={[s.fill, s.overlay]} resizeMode="contain" /> : null}
      </Animated.View>
      {brackets ? (
        <>
          <View style={[s.bracket, s.tl]} /><View style={[s.bracket, s.tr]} />
          <View style={[s.bracket, s.bl]} /><View style={[s.bracket, s.br]} />
        </>
      ) : null}
      <View style={s.hud}>
        <Pressable style={s.hudBtn} onPress={() => setZoom((z) => clamp(z - 0.25))} accessibilityLabel="Zoom out"><Text style={s.hudText}>−</Text></Pressable>
        <Pressable style={s.hudBadge} onPress={reset} accessibilityLabel="Reset zoom"><Text style={s.hudText}>{Math.round(zoom * 100)}%</Text></Pressable>
        <Pressable style={s.hudBtn} onPress={() => setZoom((z) => clamp(z + 0.25))} accessibilityLabel="Zoom in"><Text style={s.hudText}>+</Text></Pressable>
        {!isDefault ? <Pressable style={s.hudBtn} onPress={reset} accessibilityLabel="Reset view"><Text style={s.hudText}>⟲</Text></Pressable> : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  frame: { backgroundColor: '#050302', overflow: 'hidden', borderWidth: 1, borderColor: t.c.border },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  overlay: { opacity: 0.55 },
  bracket: { position: 'absolute', width: 18, height: 18, borderColor: t.c.crimson },
  tl: { top: 8, left: 8, borderTopWidth: 2, borderLeftWidth: 2 },
  tr: { top: 8, right: 8, borderTopWidth: 2, borderRightWidth: 2 },
  bl: { bottom: 8, left: 8, borderBottomWidth: 2, borderLeftWidth: 2 },
  br: { bottom: 8, right: 8, borderBottomWidth: 2, borderRightWidth: 2 },
  hud: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 4,
    backgroundColor: 'rgba(26, 16, 8, 0.75)',
    padding: 4,
  },
  hudBtn: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(250,246,239,0.3)' },
  hudBadge: { minWidth: 56, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.crimson },
  hudText: { fontFamily: t.fonts.monoBold, fontSize: 12, color: '#FAF6EF' },
}));
