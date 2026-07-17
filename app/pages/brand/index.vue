<script setup lang="ts">
definePageMeta({ layout: false });
useHead({ title: 'DevFathom brand system' });
const colors = [
  ['Forest', '#263128'],
  ['Clay', '#b14e32'],
  ['Paper', '#fffcf6'],
  ['Linen', '#f7f1e5'],
  ['Border', '#e1d3c1'],
];
</script>

<template>
  <main class="brand-book">
    <nav>
      <NuxtLink to="/brand"
        ><img src="/favicon.svg" alt="" width="34" height="34" /><strong
          >DevFathom</strong
        ></NuxtLink
      ><NuxtLink to="/brand/preview">Open preview →</NuxtLink>
    </nav>
    <header>
      <span>Identity register · 01</span>
      <h1>Clarity for the work beneath the surface.</h1>
      <p>
        A quiet, editorial system for a company workspace: grounded forest, working-paper neutrals,
        and a single clay signal.
      </p>
    </header>
    <section>
      <div class="section-label">Mark & word</div>
      <div class="mark-card">
        <img src="/favicon.svg" alt="DevFathom mark" width="92" height="92" />
        <h2>DevFathom</h2>
        <p>Company workspace</p>
      </div>
    </section>
    <section>
      <div class="section-label">Core palette</div>
      <div class="swatches">
        <article v-for="color in colors" :key="color[0]" :style="{ background: color[1] }">
          <span>{{ color[0] }}</span
          ><code>{{ color[1] }}</code>
        </article>
      </div>
    </section>
    <section>
      <div class="section-label">Type voice</div>
      <div class="type-grid">
        <article>
          <small>Newsreader · Display</small>
          <h2>Decisions deserve room to breathe.</h2>
        </article>
        <article>
          <small>IBM Plex Sans · Working text</small>
          <p>Precise enough for dense operational records, warm enough to remain human.</p>
          <code>IBM PLEX MONO · 09 / REGISTER</code>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.brand-book {
  min-height: 100vh;
  padding-bottom: 80px;
  color: #263128;
  background: #fffcf6;
}
nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 22px 5vw;
  border-bottom: 1px solid #e1d3c1;
}
nav a:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
}
nav a:last-child {
  color: #b14e32;
  font:
    10px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
header {
  padding: 11vw 8vw 9vw;
  background: #263128;
  color: #fffcf6;
}
header span,
.section-label {
  font:
    500 9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.18em;
}
header span {
  color: #d39178;
}
header h1 {
  max-width: 840px;
  margin: 24px 0;
  font:
    500 clamp(48px, 8vw, 104px)/0.94 'Newsreader',
    serif;
  letter-spacing: -0.045em;
}
header p {
  max-width: 560px;
  color: #bcc7ba;
  line-height: 1.7;
}
section {
  padding: 70px 8vw;
  border-bottom: 1px solid #e1d3c1;
}
.section-label {
  margin-bottom: 28px;
  color: #b14e32;
}
.mark-card {
  padding: 54px;
  text-align: center;
  background: #f7f1e5;
}
.mark-card h2 {
  margin: 18px 0 2px;
  font-size: 42px;
}
.mark-card p {
  color: #73766d;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 9px;
}
.swatches {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
}
.swatches article {
  min-height: 190px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 16px;
  border: 1px solid rgba(38, 49, 40, 0.13);
}
.swatches article:nth-child(-n + 2) {
  color: white;
}
.swatches span,
.swatches code {
  font-size: 10px;
}
.swatches code {
  margin-top: 4px;
  opacity: 0.7;
}
.type-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 60px;
}
.type-grid small,
.type-grid code {
  color: #b14e32;
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.type-grid h2 {
  margin-top: 18px;
  font-size: 54px;
}
.type-grid p {
  margin: 18px 0 36px;
  font-size: 18px;
  line-height: 1.6;
}
@media (max-width: 700px) {
  .swatches,
  .type-grid {
    grid-template-columns: 1fr;
  }
  .swatches article {
    min-height: 110px;
  }
}
</style>
