/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
      colors: {
        ink: {
          DEFAULT: '#1d1d1f',
          secondary: '#86868b',
          tertiary: '#d2d2d7',
        },
        surface: {
          DEFAULT: '#ffffff',
          alt: '#f5f5f7',
          elevated: '#fbfbfd',
        },
        accent: {
          DEFAULT: '#0071e3',
          hover: '#0077ed',
        },
        signal: {
          breakout: '#ff375f',
          strong: '#ff9500',
          rising: '#34c759',
        },
      },
      fontSize: {
        'display': ['80px', { lineHeight: '1.05', letterSpacing: '-0.015em', fontWeight: '600' }],
        'headline': ['48px', { lineHeight: '1.1', letterSpacing: '-0.01em', fontWeight: '600' }],
        'title': ['28px', { lineHeight: '1.15', letterSpacing: '-0.005em', fontWeight: '600' }],
        'body-lg': ['21px', { lineHeight: '1.4', fontWeight: '400' }],
        'body': ['17px', { lineHeight: '1.47', fontWeight: '400' }],
        'caption': ['14px', { lineHeight: '1.4', fontWeight: '400' }],
        'eyebrow': ['12px', { lineHeight: '1.33', letterSpacing: '0.08em', fontWeight: '600' }],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
        '30': '7.5rem',
      },
      borderRadius: {
        'ive': '12px',
        'ive-lg': '20px',
        'ive-xl': '28px',
      },
      boxShadow: {
        'ive': '0 2px 12px rgba(0,0,0,0.08)',
        'ive-lg': '0 8px 30px rgba(0,0,0,0.12)',
        'ive-glow': '0 0 40px rgba(0,113,227,0.15)',
      },
      animation: {
        'fade-up': 'fadeUp 0.6s ease-out',
        'fade-in': 'fadeIn 0.4s ease-out',
        'count-up': 'countUp 2s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
}
