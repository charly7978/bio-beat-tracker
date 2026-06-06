import type { CapacitorConfig } from '@capacitor/cli';

const keystorePath = process.env.CAPACITOR_KEYSTORE_PATH;
const keystorePassword = process.env.CAPACITOR_KEYSTORE_PASSWORD;
const keystoreAlias = process.env.CAPACITOR_KEYSTORE_ALIAS;
const keystoreAliasPassword = process.env.CAPACITOR_KEYSTORE_ALIAS_PASSWORD;

const config: CapacitorConfig = {
  appId: 'com.biobeat.tracker',
  appName: 'Bio-Beat Tracker',
  webDir: 'dist',
  android: {
    buildOptions: {
      keystorePath: keystorePath || undefined,
      keystorePassword: keystorePassword || undefined,
      keystoreAlias: keystoreAlias || undefined,
      keystoreAliasPassword: keystoreAliasPassword || undefined,
      releaseType: 'APK',
      signingType: 'apksigner',
    },
  },
  plugins: {
    Camera: { saveToGallery: false },
    Health: { enabled: true },
    BackgroundTask: { enabled: true },
    Filesystem: { enabled: true },
    Preferences: { enabled: true },
    Network: { enabled: true },
  },
};

export default config;
