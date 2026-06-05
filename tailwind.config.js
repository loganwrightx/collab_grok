/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Modern dark theme inspired by grok.com - neon cyan accents on deep black, clean minimal, user's own twist
        bg: '#0a0a0a',
        'bg-elev': '#111111',
        'bg-card': '#1a1a1a',
        border: '#262626',
        muted: '#a1a1aa',
        accent: '#22d3ee', // neon cyan-blue
        'accent-dark': '#06b6d4',
        grok: '#3b82f6', // distinct for AI
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
