
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { makeStyles, useTheme } from '../theme/ThemeContext';

export interface InfoRow { term: string; text: string; }

export function InfoModalButton({ title, rows }: { title: string; rows: InfoRow[] }) {
  const [open, setOpen] = useState(false);
  const s = useStyles();
  const { theme } = useTheme();
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${title} info`}
        style={s.button}
        hitSlop={8}
      >
        <Text style={s.buttonText}>i</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={s.modalWrap} pointerEvents="box-none">
          <View style={s.modal}>
            <View style={s.header}>
              <Text style={s.title}>{title}</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                <Text style={[s.title, { color: theme.c.crimson }]}>✕</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {rows.map((r) => (
                <Text key={r.term} style={s.row}>
                  <Text style={s.term}>{r.term}: </Text>
                  {r.text}
                </Text>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  button: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: t.c.crimson,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 6,
  },
  buttonText: { fontFamily: t.fonts.heavy, fontSize: 12, color: t.c.crimson },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: {
    width: '100%', maxWidth: 420,
    backgroundColor: t.c.creamLight,
    borderWidth: 2, borderColor: t.c.crimson,
    padding: 16,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: t.c.crimson,
    paddingBottom: 10, marginBottom: 12,
  },
  title: { fontFamily: t.fonts.heavy, fontSize: 15, color: t.c.crimson, letterSpacing: 1 },
  term: { fontFamily: t.fonts.monoBold, color: t.c.crimson },
  row: { fontFamily: t.fonts.body, fontSize: 12.5, lineHeight: 19, color: t.c.text, marginBottom: 10 },
}));
