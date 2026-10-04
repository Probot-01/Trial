
import * as SecureStore from 'expo-secure-store';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function secretGet(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, OPTS);
}

export async function secretSet(key: string, value: string | null): Promise<void> {
  if (value === null) await SecureStore.deleteItemAsync(key, OPTS);
  else await SecureStore.setItemAsync(key, value, OPTS);
}
