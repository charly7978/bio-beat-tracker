import { Capacitor } from '@capacitor/core';

export type Platform = 'web' | 'android' | 'ios';

export function getPlatform(): Platform {
  if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() as Platform;
  }
  return 'web';
}

export function isNative(): boolean {
  return getPlatform() !== 'web';
}
