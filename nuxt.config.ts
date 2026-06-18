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
  // Strip Vue's devtools instrumentation from the production bundle. Without
  // this, @vue/devtools-api -> @vue/devtools-kit -> hookable stays in
  // .output/server/node_modules/, and Electron's asar ESM resolver chokes
  // on nested node_modules when hookable isn't hoisted at the top level.
  vite: { define: { __VUE_PROD_DEVTOOLS__: 'false' } },
  nitro: {
    preset: 'node-server',
    // Global error safety net. See server/error.ts. Uses `~~/` (project
    // root) because Nuxt 4 remapped `~/` to `<rootDir>/app/`, so the
    // previously-correct `~/server/error` resolves to `app/server/error`
    // and Nitro fails to load at boot.
    errorHandler: '~~/server/error',
    // sherpa-onnx-node loads its platform-specific .node binary at runtime
    // via __dirname, so it must stay external (not bundled into .output/).
    externals: {
      external: ['sherpa-onnx-node'],
    },
    // Even with sherpa-onnx-node external, rollup still follows the side-effect
    // import in rawDiarization.ts and tries to PARSE the platform .node binary
    // (e.g. sherpa-onnx-win-x64/sherpa-onnx.node) as JavaScript — fails with
    // 'Unexpected character \0' on the PE 'MZ' header. nitro.externals can't
    // prevent this (it only controls runtime bundling, not parse-time). So at
    // the rollup:before hook, inject a plugin whose resolveId returns
    // { external: true } for any *.node file, telling rollup to treat it as a
    // runtime require and never read its contents.
    hooks: {
      'rollup:before': (_nitro, config) => {
        const skipNodeBinaries = {
          name: 'skip-node-binaries',
          resolveId(source: string) {
            if (!source || !source.endsWith('.node')) return null;
            return { id: source, external: true };
          },
        };
        const existing = config.plugins;
        const plugins = Array.isArray(existing) ? existing : existing ? [existing] : [];
        config.plugins = [...plugins, skipNodeBinaries];
      },
    },
  },
  devServer: { host: '0.0.0.0', port: 3000 },
  i18n: {
    locales: [
      { code: 'en', file: 'en.json', name: 'English' },
      { code: 'zh', file: 'zh-CN.json', name: '简体中文' },
      { code: 'zh-TW', file: 'zh-TW.json', name: '繁體中文' },
      { code: 'ja', file: 'ja.json', name: '日本語' },
      { code: 'es', file: 'es.json', name: 'Español' },
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
