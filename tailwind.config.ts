import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{vue,js,ts}', './server/**/*.{js,ts}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
