// SUBCAST_BUILD_TARGET=desktop switches to SPA + relative baseURL for
// Electron packaging. Web/dev defaults stay SSR.
const IS_DESKTOP_BUILD = process.env.SUBCAST_BUILD_TARGET === 'desktop';

export default defineNuxtConfig({
  compatibilityDate: '2026-05-01',
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/i18n', 'shadcn-nuxt', '@nuxt/eslint'],
  shadcn: {
    prefix: '',
    componentDir: './app/components/ui',
  },
  css: ['~/assets/css/tailwind.css'],
  ssr: !IS_DESKTOP_BUILD,
  app: {
    baseURL: IS_DESKTOP_BUILD ? './' : '/',
    head: {
      title: 'Subcast',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      // Surface SUBCAST_DESKTOP to the SSR pass and client hydration so
      // `useDesktop()` can return the correct value before window.subcast
      // is available. Read at server start (dev:desktop:hot orchestrator
      // sets the env before spawning); harmless in web mode.
      isDesktopServer: process.env.SUBCAST_DESKTOP === 'true',
    },
  },
  typescript: { strict: true, typeCheck: false },
  nitro: {
    preset: 'node-server',
    // Global error safety net. See server/error.ts. Uses `~~/` (project
    // root) because Nuxt 4 remapped `~/` to `<rootDir>/app/`, so the
    // previously-correct `~/server/error` resolves to `app/server/error`
    // and Nitro fails to load at boot.
    errorHandler: '~~/server/error',
  },
  devServer: { host: '0.0.0.0', port: 3000 },
  i18n: {
    locales: [
      { code: 'en', file: 'en.json', name: 'English' },
      { code: 'zh', file: 'zh-CN.json', name: '中文' },
    ],
    defaultLocale: 'en',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'subcast_lang',
      redirectOn: 'root',
    },
  },
});
