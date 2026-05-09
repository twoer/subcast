export default defineNuxtConfig({
  compatibilityDate: '2026-05-01',
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/tailwind.css'],
  typescript: { strict: true, typeCheck: false },
  nitro: { preset: 'node-server' },
  devServer: { host: '0.0.0.0', port: 3000 },
});
