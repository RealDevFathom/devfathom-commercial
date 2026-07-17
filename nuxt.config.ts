export default defineNuxtConfig({
  compatibilityDate: '2026-07-12',
  devtools: { enabled: true },
  modules: ['@nuxtjs/color-mode'],
  vite: {
    optimizeDeps: {
      include: ['@vue/devtools-core', '@vue/devtools-kit', 'lucide-vue-next'],
    },
  },
  css: ['~/assets/css/main.css', '~/assets/css/production.css'],
  postcss: {
    plugins: {
      '@tailwindcss/postcss': {},
    },
  },
  runtimeConfig: {
    public: {
      apiBase:
        process.env.NUXT_PUBLIC_API_BASE ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:8000'),
    },
  },
  colorMode: {
    classSuffix: '',
    preference: 'system',
    fallback: 'light',
  },
  app: {
    head: {
      title: 'DevFathom Hub',
      meta: [
        { name: 'description', content: 'DevFathom company workspace' },
        { name: 'theme-color', content: '#e8e8e5' },
      ],
      link: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    },
  },
});
