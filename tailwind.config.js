/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 10px 30px rgba(255, 106, 77, 0.18)",
      },
      colors: {
        brand: {
          50: "#fff8f6",
          100: "#ffede7",
          200: "#ffd8cb",
          300: "#ffb69f",
          400: "#ff8a67",
          500: "#ff6a4d",
          600: "#f14a29",
          700: "#c93a1d",
          800: "#a6341e",
          900: "#872f1f",
        },
      },
      animation: {
        "fade-in": "fade-in 0.35s ease-out",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: 0, transform: "translateY(6px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
