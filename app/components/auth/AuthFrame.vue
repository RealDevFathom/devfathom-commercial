<script setup lang="ts">
defineProps<{ eyebrow: string; title: string; description: string }>();
</script>
<template>
  <main class="auth-page">
    <section class="story">
      <div class="auth-brand">
        <AppLogo :size="44" /><strong>DevFathom</strong><span>Fieldbook / access</span>
      </div>
      <div>
        <p>The delivery desk</p>
        <h1>Work with the whole picture.</h1>
        <span>Secure access to the firm’s working record.</span>
      </div>
      <small><i /> All systems operational · DevFathom</small>
    </section>
    <section class="form-wrap">
      <div class="auth-card">
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
        <p class="description">{{ description }}</p>
        <slot />
      </div>
    </section>
  </main>
</template>
<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(340px, 0.9fr) minmax(420px, 1.1fr);
  background: #f7f7f5;
}
.story {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(28px, 6vw, 78px);
  color: white;
  background-color: #162f2b;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
  background-size: 56px 56px;
}
.auth-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.auth-brand strong {
  font-size: 20px;
}
.auth-brand span {
  margin-left: auto;
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 6px 10px;
  color: rgba(255, 255, 255, 0.7);
  font: 600 9px var(--font-mono);
  text-transform: uppercase;
}
.story p,
.eyebrow {
  color: #ff684f;
  font: 600 9px var(--font-mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.story h1 {
  max-width: 510px;
  margin: 8px 0;
  font-size: clamp(42px, 6vw, 72px);
  font-weight: 650;
  line-height: 0.92;
  letter-spacing: -0.055em;
}
.story span {
  color: #b9c2b7;
}
.story small {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.58);
  font: 9px var(--font-mono);
  text-transform: uppercase;
}
.story small i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34d399;
}
.form-wrap {
  display: grid;
  place-items: center;
  padding: 32px;
}
.auth-card {
  width: min(480px, 100%);
  padding: 30px;
  border: 1px solid var(--border-subtle);
  border-left: 2px solid #ff684f;
  border-radius: 4px;
  background: white;
  box-shadow: var(--shadow-sm);
}
.eyebrow {
  color: #ff684f;
}
h2 {
  margin: 5px 0;
  font-size: 34px;
  font-weight: 650;
  letter-spacing: -0.04em;
}
.description {
  margin-bottom: 24px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 760px) {
  .auth-page {
    grid-template-columns: 1fr;
  }
  .story {
    min-height: 250px;
  }
  .story h1 {
    font-size: 42px;
  }
  .form-wrap {
    padding: 18px;
  }
}
</style>
