import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.lovable.9d074359befd41d0930739b75ab20410',
  appName: 'Bearbeat CRM',
  webDir: 'dist',
  server: {
    url: 'https://9d074359-befd-41d0-9307-39b75ab20410.lovableproject.com?forceHideBadge=true',
    cleartext: true
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#1a1a2e',
      showSpinner: false,
    },
  },
};

export default config;
