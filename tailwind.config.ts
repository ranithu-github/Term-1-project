import type { Config } from 'tailwindcss';

// Colors come from the CSS variables in app/globals.css, so Tailwind and the
// component classes always agree.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./components/**/*.{ts,tsx}', './app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: token('navy'),
        blue: { DEFAULT: token('blue'), press: token('blue-press') },
        sky: token('sky'),
        paper: token('paper'),
        card: token('card'),
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3') },
        line: token('line'),
        success: { DEFAULT: token('success'), bg: token('success-bg') },
        caution: { DEFAULT: token('caution'), bg: token('caution-bg') },
        danger: { DEFAULT: token('danger'), bg: token('danger-bg') },
        // legacy palette, still used by the admin panel
        brand: { 50: '#f1f5fd', 100: '#e2eafa', 200: '#c3d3f4', 300: '#94b0ea', 500: '#2f5fd0', 600: '#1f4fc2', 700: '#183f9e', 900: '#0f1e3d' },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        body: ['var(--font-body)', '-apple-system', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
        standard: 'var(--ease-standard)',
        drawer: 'var(--ease-drawer)',
      },
    },
  },
  plugins: [],
};
export default config;
