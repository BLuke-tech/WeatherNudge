import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#162133",
        sky: "#d9ecff",
        mist: "#f4f8fc",
        tide: "#1f6fb2",
        pine: "#1f7a53",
        amber: "#b7791f",
        coral: "#b64b4b"
      },
      boxShadow: {
        panel: "0 22px 50px -24px rgba(22, 33, 51, 0.25)"
      },
      backgroundImage: {
        "hero-glow":
          "radial-gradient(circle at top left, rgba(112, 182, 255, 0.35), transparent 42%), radial-gradient(circle at top right, rgba(71, 176, 129, 0.18), transparent 32%)"
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
