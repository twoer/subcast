export default defineNuxtConfig({
  compatibilityDate: '2026-05-01',
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/i18n', 'shadcn-nuxt'],
  shadcn: {
    prefix: '',
    componentDir: './app/components/ui',
  },
  css: ['~/assets/css/tailwind.css'],
  app: {
    head: {
      title: 'Subcast',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  typescript: { strict: true, typeCheck: false },
  nitro: { preset: 'node-server', experimental: { websocket: true } },
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
    bundle: { optimizeTranslationDirective: false },
  },
});
