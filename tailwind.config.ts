
import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
  	container: {
  		center: true,
  		padding: '2rem',
  		screens: {
  			'2xl': '1400px'
  		}
  	},
  		extend: {
  			colors: {
  				border: 'hsl(var(--border))',
  				input: 'hsl(var(--input))',
  				ring: 'hsl(var(--ring))',
  				background: 'hsl(var(--background))',
  				foreground: 'hsl(var(--foreground))',
  				primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			}
  		},
  		keyframes: {
  			'value-glow': {
  				'0%, 100%': {
  					textShadow: '0 0 1px rgba(255,255,255,0.2)'
  				},
  				'50%': {
  					textShadow: '0 0 20px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.6)'
  				}
  			},
  			'fade-in': {
  				'0%': { opacity: '0', transform: 'translateY(4px)' },
  				'100%': { opacity: '1', transform: 'translateY(0)' }
  			}
  		},
  		animation: {
  			'value-glow': 'value-glow 3s ease-in-out infinite',
  			'fade-in': 'fade-in 200ms ease-out'
  		},
  		fontFamily: {
  			sans: [
  				'Work Sans',
  				'ui-sans-serif',
  				'system-ui',
  				'sans-serif',
  				'Apple Color Emoji',
  				'Segoe UI Emoji',
  				'Segoe UI Symbol',
  				'Noto Color Emoji'
  			],
  			serif: [
  				'Lora',
  				'ui-serif',
  				'Georgia',
  				'Cambria',
  				'Times New Roman',
  				'Times',
  				'serif'
  			],
  			mono: [
  				'Source Code Pro',
  				'ui-monospace',
  				'SFMono-Regular',
  				'Menlo',
  				'Monaco',
  				'Consolas',
  				'Liberation Mono',
  				'Courier New',
  				'monospace'
  			]
  		}
  	}
  },
  plugins: [
    require("tailwindcss-animate"),
    function({ addUtilities }) {
      const newUtilities = {
        '.text-gradient-soft': {
          background: 'linear-gradient(to bottom, #FFFFFF, #F2FCE2)',
          '-webkit-background-clip': 'text',
          'background-clip': 'text',
          'color': 'transparent',
          'text-shadow': '0 0 5px rgba(255,255,255,0.3)'
        },
      }
      addUtilities(newUtilities)
    }
  ],
} satisfies Config;
