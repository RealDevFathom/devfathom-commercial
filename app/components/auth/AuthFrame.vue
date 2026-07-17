<script setup lang="ts">
defineProps<{ eyebrow: string; title: string; description: string }>();
</script>

<template>
  <main class="fieldbook-auth">
    <section class="fieldbook-hero" aria-labelledby="fieldbook-hero-title">
      <div class="fieldbook-grid" aria-hidden="true" />
      <div class="fieldbook-ring fieldbook-ring-large" aria-hidden="true" />
      <div class="fieldbook-ring fieldbook-ring-small" aria-hidden="true" />

      <div class="fieldbook-hero-content">
        <header class="fieldbook-brand-row">
          <div class="fieldbook-wordmark">
            <AppLogo :size="44" variant="white" />
            <strong>DevFathom</strong>
          </div>
          <span class="fieldbook-badge">Fieldbook / 01</span>
        </header>

        <div class="fieldbook-story">
          <p class="fieldbook-story-label">The delivery desk</p>
          <h1 id="fieldbook-hero-title">
            <span>Work with</span>
            <span>the whole</span>
            <span>picture.</span>
          </h1>
          <p class="fieldbook-story-copy">
            Projects, finance, clients, and people — each moving part visible before it becomes a
            decision.
          </p>
        </div>

        <footer class="fieldbook-status">
          <span class="fieldbook-status-copy">
            <span class="fieldbook-live-dot" aria-hidden="true"><span /></span>
            <span>All systems operational</span>
          </span>
          <span>DevFathom · Company hub</span>
        </footer>
      </div>
    </section>

    <section class="fieldbook-panel" aria-labelledby="fieldbook-panel-title">
      <div class="fieldbook-panel-inner">
        <div class="fieldbook-mobile-brand">
          <div class="fieldbook-mobile-wordmark">
            <AppLogo :size="34" variant="dark" />
            <strong>DevFathom</strong>
          </div>
          <span>Fieldbook / 01</span>
        </div>

        <div class="fieldbook-panel-rule">
          <header class="fieldbook-panel-header">
            <p class="fieldbook-eyebrow">{{ eyebrow }}</p>
            <h2 id="fieldbook-panel-title">{{ title }}</h2>
            <p class="fieldbook-description">{{ description }}</p>
          </header>

          <div class="fieldbook-auth-content">
            <slot />
          </div>
        </div>

        <div v-if="$slots.footer" class="fieldbook-panel-footer">
          <slot name="footer" />
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.fieldbook-auth {
  --auth-ink: #111110;
  --auth-body: #333330;
  --auth-muted: #767672;
  --auth-faint: #a3a39e;
  --auth-line: #deded9;
  --auth-line-soft: #e9e9e5;
  --auth-paper: #ffffff;
  --auth-canvas: #f6f6f3;
  --auth-accent: #ff684f;
  --auth-accent-soft: #fff0ec;
  display: grid;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  grid-template-columns: minmax(0, 1.08fr) minmax(26rem, 0.92fr);
  color: var(--auth-ink);
  background: var(--auth-canvas);
  color-scheme: light;
  font-family: var(--font-sans, 'Instrument Sans', system-ui, sans-serif);
}

.fieldbook-hero {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 100dvh;
  overflow: hidden;
  color: #ffffff;
  background: #111110;
  isolation: isolate;
}

.fieldbook-grid {
  pointer-events: none;
  position: absolute;
  inset: 0;
  z-index: -2;
  opacity: 0.56;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.075) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.075) 1px, transparent 1px);
  background-size: 56px 56px;
}

.fieldbook-grid::after {
  position: absolute;
  inset: 0;
  content: '';
  background: radial-gradient(circle at 78% 68%, rgba(255, 104, 79, 0.12), transparent 36%);
}

.fieldbook-ring {
  pointer-events: none;
  position: absolute;
  right: -5rem;
  bottom: -5rem;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.fieldbook-ring-large {
  width: min(33vw, 30rem);
  height: min(33vw, 30rem);
}

.fieldbook-ring-small {
  right: -1.5rem;
  bottom: -1rem;
  width: min(21vw, 18rem);
  height: min(21vw, 18rem);
  border-color: rgba(255, 255, 255, 0.09);
}

.fieldbook-hero-content {
  position: relative;
  z-index: 1;
  display: flex;
  width: 100%;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(3rem, 4.4vw, 4rem);
}

.fieldbook-brand-row,
.fieldbook-wordmark,
.fieldbook-status,
.fieldbook-status-copy,
.fieldbook-mobile-brand,
.fieldbook-mobile-wordmark {
  display: flex;
  align-items: center;
}

.fieldbook-brand-row {
  justify-content: space-between;
}

.fieldbook-wordmark,
.fieldbook-mobile-wordmark {
  gap: 12px;
}

.fieldbook-wordmark strong,
.fieldbook-mobile-wordmark strong {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.035em;
}

.fieldbook-badge,
.fieldbook-mobile-brand > span {
  border: 1px solid rgba(255, 255, 255, 0.22);
  padding: 6px 11px;
  color: rgba(255, 255, 255, 0.72);
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.fieldbook-story {
  max-width: 34rem;
}

.fieldbook-story-label,
.fieldbook-eyebrow {
  margin: 0;
  color: var(--auth-accent);
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.fieldbook-story h1 {
  margin: 24px 0 0;
  color: #ffffff;
  font-size: clamp(3rem, 5vw, 5.5rem);
  font-weight: 650;
  line-height: 0.91;
  letter-spacing: -0.065em;
}

.fieldbook-story h1 span {
  display: block;
}

.fieldbook-story h1 span:last-child {
  color: var(--auth-accent);
}

.fieldbook-story-copy {
  max-width: 24rem;
  margin: 28px 0 0;
  color: rgba(255, 255, 255, 0.64);
  font-size: 16px;
  line-height: 1.65;
}

.fieldbook-status {
  gap: 24px;
  color: rgba(255, 255, 255, 0.54);
  font-size: 13px;
}

.fieldbook-status-copy {
  gap: 9px;
}

.fieldbook-live-dot {
  position: relative;
  display: inline-flex;
  width: 8px;
  height: 8px;
}

.fieldbook-live-dot::before,
.fieldbook-live-dot span {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: #55c878;
}

.fieldbook-live-dot::before {
  content: '';
  animation: fieldbook-ping 1.5s ease-out infinite;
}

.fieldbook-panel {
  display: flex;
  min-width: 0;
  min-height: 100dvh;
  overflow-y: auto;
  align-items: center;
  justify-content: center;
  padding: 40px clamp(28px, 5vw, 64px);
  background: var(--auth-paper);
}

.fieldbook-panel-inner {
  width: 100%;
  max-width: 400px;
  margin: auto;
}

.fieldbook-mobile-brand {
  display: none;
  justify-content: space-between;
  margin-bottom: 34px;
}

.fieldbook-mobile-wordmark strong {
  font-size: 17px;
}

.fieldbook-mobile-brand > span {
  border-color: var(--auth-line);
  color: var(--auth-muted);
  font-size: 9px;
}

.fieldbook-panel-rule {
  border-left: 2px solid var(--auth-ink);
  padding-left: 24px;
}

.fieldbook-panel-header {
  margin-bottom: 28px;
}

.fieldbook-eyebrow {
  letter-spacing: 0.18em;
}

.fieldbook-panel-header h2 {
  margin: 12px 0 0;
  color: var(--auth-ink);
  font-size: clamp(2rem, 4vw, 2.7rem);
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.052em;
}

.fieldbook-description {
  max-width: 24rem;
  margin: 10px 0 0;
  color: var(--auth-muted);
  font-size: 14px;
  line-height: 1.65;
}

.fieldbook-panel-footer {
  margin: 30px 0 0 26px;
  color: var(--auth-muted);
  font-size: 12px;
  line-height: 1.6;
}

.fieldbook-auth-content :deep(.fieldbook-stack),
.fieldbook-auth-content :deep(.fieldbook-state) {
  display: grid;
  gap: 20px;
}

.fieldbook-auth-content :deep(.fieldbook-field) {
  display: grid;
  gap: 8px;
}

.fieldbook-auth-content :deep(.fieldbook-label-row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.fieldbook-auth-content :deep(label),
.fieldbook-auth-content :deep(.fieldbook-label) {
  color: var(--auth-ink);
  font-size: 14px;
  font-weight: 620;
}

.fieldbook-auth-content :deep(.fieldbook-input),
.fieldbook-auth-content :deep(.fieldbook-textarea) {
  width: 100%;
  min-height: 48px;
  border: 1px solid var(--auth-line);
  border-radius: 3px;
  padding: 0 14px;
  color: var(--auth-ink);
  background: var(--auth-paper);
  outline: none;
  font-size: 14px;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease,
    background 160ms ease;
}

.fieldbook-auth-content :deep(.fieldbook-textarea) {
  min-height: 88px;
  padding-block: 12px;
  resize: vertical;
}

.fieldbook-auth-content :deep(.fieldbook-input::placeholder),
.fieldbook-auth-content :deep(.fieldbook-textarea::placeholder) {
  color: var(--auth-faint);
}

.fieldbook-auth-content :deep(.fieldbook-input:focus),
.fieldbook-auth-content :deep(.fieldbook-textarea:focus) {
  border-color: var(--auth-ink);
  box-shadow: 0 0 0 3px rgba(17, 17, 16, 0.1);
}

.fieldbook-auth-content :deep(.fieldbook-input:disabled) {
  color: var(--auth-muted);
  background: var(--auth-canvas);
}

.fieldbook-auth-content :deep(.fieldbook-helper) {
  margin: 0;
  color: var(--auth-muted);
  font-size: 12px;
  line-height: 1.55;
}

.fieldbook-auth-content :deep(.fieldbook-password) {
  position: relative;
}

.fieldbook-auth-content :deep(.fieldbook-password .fieldbook-input) {
  padding-right: 44px;
}

.fieldbook-auth-content :deep(.fieldbook-password-toggle) {
  position: absolute;
  top: 50%;
  right: 0;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 0;
  padding: 0;
  color: var(--auth-muted);
  background: transparent;
  transform: translateY(-50%);
  cursor: pointer;
}

.fieldbook-auth-content :deep(.fieldbook-password-toggle:hover) {
  color: var(--auth-ink);
}

.fieldbook-auth-content :deep(.fieldbook-primary) {
  display: inline-flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--auth-ink);
  border-radius: 3px;
  padding: 0 18px;
  color: #ffffff;
  background: var(--auth-ink);
  box-shadow: 0 12px 24px -18px rgba(17, 17, 16, 0.7);
  font-size: 14px;
  font-weight: 650;
  text-align: center;
  cursor: pointer;
  transition:
    transform 160ms ease,
    background 160ms ease,
    opacity 160ms ease;
}

.fieldbook-auth-content :deep(.fieldbook-primary:hover) {
  background: #2c2c2a;
  transform: translateY(-1px);
}

.fieldbook-auth-content :deep(.fieldbook-primary:active) {
  transform: translateY(0);
}

.fieldbook-auth-content :deep(.fieldbook-primary:disabled) {
  pointer-events: none;
  opacity: 0.52;
}

.fieldbook-auth-content :deep(.fieldbook-link),
.fieldbook-auth-content :deep(.fieldbook-secondary) {
  border: 0;
  padding: 0;
  color: var(--auth-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 620;
  text-decoration: none;
  text-underline-offset: 4px;
  cursor: pointer;
  transition: color 150ms ease;
}

.fieldbook-auth-content :deep(.fieldbook-link:hover),
.fieldbook-auth-content :deep(.fieldbook-secondary:hover) {
  color: var(--auth-ink);
  text-decoration: underline;
}

.fieldbook-auth-content :deep(.fieldbook-secondary) {
  justify-self: center;
}

.fieldbook-auth-content :deep(.fieldbook-alert) {
  margin: 0 0 20px;
  border: 1px solid #efc4bd;
  border-radius: 3px;
  padding: 12px 14px;
  color: #943c2e;
  background: #fff5f2;
  font-size: 13px;
  line-height: 1.55;
}

.fieldbook-auth-content :deep(.fieldbook-alert--hint) {
  border-color: var(--auth-line);
  color: var(--auth-body);
  background: var(--auth-canvas);
}

.fieldbook-auth-content :deep(.fieldbook-state-icon) {
  color: var(--auth-accent);
}

.fieldbook-auth-content :deep(.fieldbook-state strong) {
  color: var(--auth-ink);
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.035em;
}

.fieldbook-auth-content :deep(.fieldbook-state p) {
  margin: -8px 0 0;
  color: var(--auth-muted);
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 1023px) {
  .fieldbook-auth {
    display: block;
    overflow-y: auto;
  }

  .fieldbook-hero {
    display: none;
  }

  .fieldbook-panel {
    min-height: 100dvh;
    padding: 40px 24px;
  }

  .fieldbook-mobile-brand {
    display: flex;
  }
}

@media (max-width: 520px) {
  .fieldbook-panel {
    align-items: flex-start;
    padding: 28px 20px 36px;
  }

  .fieldbook-mobile-brand {
    margin-bottom: 42px;
  }

  .fieldbook-panel-rule {
    padding-left: 20px;
  }

  .fieldbook-panel-footer {
    margin-left: 22px;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .fieldbook-brand-row,
  .fieldbook-story-label,
  .fieldbook-story h1 span,
  .fieldbook-story-copy,
  .fieldbook-status,
  .fieldbook-panel-inner {
    animation: fieldbook-reveal 620ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .fieldbook-story-label {
    animation-delay: 80ms;
  }

  .fieldbook-story h1 span:nth-child(1) {
    animation-delay: 120ms;
  }

  .fieldbook-story h1 span:nth-child(2) {
    animation-delay: 180ms;
  }

  .fieldbook-story h1 span:nth-child(3) {
    animation-delay: 240ms;
  }

  .fieldbook-story-copy {
    animation-delay: 300ms;
  }

  .fieldbook-status {
    animation-delay: 360ms;
  }

  .fieldbook-panel-inner {
    animation-delay: 80ms;
  }
}

@keyframes fieldbook-reveal {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fieldbook-ping {
  70%,
  100% {
    opacity: 0;
    transform: scale(2.25);
  }
}
</style>
