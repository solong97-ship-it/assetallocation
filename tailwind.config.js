/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 14px 36px rgba(0, 0, 0, 0.3)",
      },
      colors: {
        brand: {
          50: "#f7f7f7",
          100: "#ebebeb",
          200: "#dadada",
          300: "#b9b9b9",
          400: "#8f8f8f",
          500: "#6a6a6a",
          600: "#4a4a4a",
          700: "#2c2c2c",
          800: "#171717",
          900: "#080808",
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
