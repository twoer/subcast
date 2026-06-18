import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./app/**/*.{vue,js,ts}', './server/**/*.{js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      // Two micro sizes below Tailwind's default `text-xs` (12px). Pre-token
      // these were sprinkled as `text-[10px]` / `text-[11px]` magic values
      // across 20+ call sites; a unified scale prevents drift and makes
      // hierarchy intent explicit.
      //
      //   text-2xs (11px) — tabular mono data: timestamps, model names,
      //                     library counts. Slightly tighter line-height
      //                     than xs because these usually live on a single
      //                     row with no wrapping.
      //   text-3xs (10px) — uppercase labels and badges with `tracking-wider`.
      //                     The wider tracking + ALL CAPS keeps them legible
      //                     at this size; never use for body or paragraph copy.
      fontSize: {
        '2xs': ['11px', { lineHeight: '1rem' }],
        '3xs': ['10px', { lineHeight: '0.875rem' }],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          strong: 'hsl(var(--primary-strong))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        cta: {
          DEFAULT: 'hsl(var(--cta))',
          foreground: 'hsl(var(--cta-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--reka-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--reka-accordion-content-height)' },
          to: { height: '0' },
        },
        // Travelling-highlight band used by the AppHeader models chip
        // to signal "a task is running, the model is held". The band is
        // a 1/3-width vertical strip of primary-tinted alpha that sweeps
        // across the chip on a continuous loop; the translateX range
        // moves it fully off-screen on both ends.
        'chip-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'chip-sweep': 'chip-sweep 2s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
