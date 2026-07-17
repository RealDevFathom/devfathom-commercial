<script setup lang="ts">
definePageMeta({ layout: false });
useHead({ title: 'DevFathom workspace preview' });
const rows = [
  ['Northline onboarding', 'In review', 'Today'],
  ['Studio operating plan', 'In progress', 'Tomorrow'],
  ['Q3 scope register', 'Filed', '14 Jul'],
];
</script>

<template>
  <main class="preview">
    <aside>
      <NuxtLink to="/brand"
        ><img src="/favicon.svg" alt="" width="38" height="38" /><strong
          >DevFathom</strong
        ></NuxtLink
      ><span>Workspace</span><a class="active">Overview</a><a>Projects</a><a>Correspondence</a
      ><a>Firm register</a>
    </aside>
    <section>
      <header>
        <div>
          <small>Monday register</small>
          <h1>Good morning, DevFathom.</h1>
        </div>
        <NuxtLink to="/login">Enter workspace</NuxtLink>
      </header>
      <div class="cards">
        <article>
          <small>Active projects</small><b>12</b><span>Three require attention</span>
        </article>
        <article>
          <small>Open decisions</small><b>08</b><span>Across five engagements</span>
        </article>
        <article><small>Team capacity</small><b>76%</b><span>Balanced this week</span></article>
      </div>
      <div class="ledger">
        <header><span>Current working files</span><small>Status · Due</small></header>
        <article v-for="row in rows" :key="row[0]">
          <strong>{{ row[0] }}</strong
          ><span>{{ row[1] }}</span
          ><time>{{ row[2] }}</time>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.preview {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 260px 1fr;
  color: #263128;
  background: #f7f1e5;
}
.preview > aside {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 26px 18px;
  color: #f8f2e7;
  background: #263128;
}
.preview > aside > a:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 42px;
  font:
    22px 'Newsreader',
    serif;
}
.preview > aside > span {
  margin: 8px 12px;
  color: #879287;
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.15em;
}
.preview > aside > a:not(:first-child) {
  padding: 12px;
  color: #c7d0c4;
}
.preview > aside > a.active {
  color: white;
  background: rgba(177, 78, 50, 0.18);
  border-left: 3px solid #b14e32;
}
.preview > section {
  padding: 0 5vw 60px;
}
.preview > section > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 55px 0 36px;
}
.preview h1 {
  margin: 8px 0 0;
  font-size: 46px;
}
.preview small {
  color: #73766d;
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.preview > section > header a {
  padding: 11px 16px;
  color: white;
  background: #b14e32;
}
.cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid #e1d3c1;
  background: #fffcf6;
}
.cards article {
  padding: 26px;
  border-right: 1px solid #e1d3c1;
}
.cards b,
.cards span {
  display: block;
}
.cards b {
  margin: 18px 0 10px;
  font:
    48px 'Newsreader',
    serif;
}
.cards span {
  color: #73766d;
  font-size: 11px;
}
.ledger {
  margin-top: 28px;
  background: #fffcf6;
  border: 1px solid #e1d3c1;
}
.ledger header,
.ledger article {
  display: grid;
  grid-template-columns: 1fr 150px 90px;
  padding: 17px 20px;
  border-bottom: 1px solid #e1d3c1;
}
.ledger header {
  background: #efe3d2;
}
.ledger article span,
.ledger article time {
  color: #73766d;
  font-size: 12px;
}
@media (max-width: 760px) {
  .preview {
    grid-template-columns: 1fr;
  }
  .preview > aside {
    display: none;
  }
  .cards {
    grid-template-columns: 1fr;
  }
  .cards article {
    border-bottom: 1px solid #e1d3c1;
  }
  .ledger header,
  .ledger article {
    grid-template-columns: 1fr 100px;
  }
  .ledger time {
    display: none;
  }
}
</style>
