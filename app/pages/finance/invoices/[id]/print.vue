<script setup lang="ts">
import { ArrowLeft, Printer } from 'lucide-vue-next';
const route = useRoute();
const api = useFirm();
const invoice = await api.invoice(String(route.params.id));
useHead({ title: `${invoice.invoiceNumber} · Invoice` });
const money = (n: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: invoice.currency }).format(Number(n));
const date = (v: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date(v));
function printInvoice() {
  if (import.meta.client) window.print();
}
</script>
<template>
  <main class="mx-auto max-w-3xl space-y-4 animate-fade-in">
    <nav class="no-print flex items-center justify-between">
      <NuxtLink
        to="/finance"
        class="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
        ><ArrowLeft :size="14" /> Back to Finance</NuxtLink
      >
      <button
        class="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        @click="printInvoice"
      >
        <Printer :size="14" /> Print / Save as PDF
      </button>
    </nav>

    <article
      id="invoice-print"
      class="rounded-2xl border border-slate-200 bg-white p-8 text-slate-900 shadow-sm sm:p-10"
    >
      <header class="flex items-start justify-between gap-6 border-b border-slate-200 pb-6">
        <div>
          <p class="font-display text-2xl font-bold tracking-tight text-[#0C2E2C]">DevFathom</p>
          <p class="mt-1 text-xs text-slate-500">hub.devfathom.com</p>
        </div>
        <div class="text-right">
          <p class="font-display text-xl font-bold tracking-tight text-slate-900">INVOICE</p>
          <p class="mt-1 font-mono text-sm text-slate-700">{{ invoice.invoiceNumber }}</p>
          <span
            class="mt-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium"
            :class="
              invoice.status === 'PAID'
                ? 'bg-emerald-100 text-emerald-700'
                : invoice.status === 'OVERDUE'
                  ? 'bg-red-100 text-red-700'
                  : invoice.status === 'SENT'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-slate-100 text-slate-600'
            "
            >{{ invoice.status.charAt(0) + invoice.status.slice(1).toLowerCase() }}</span
          >
        </div>
      </header>

      <section class="grid grid-cols-1 gap-6 py-6 sm:grid-cols-2">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Bill to</p>
          <p class="mt-1.5 text-sm font-semibold text-slate-900">{{ invoice.clientName }}</p>
          <p v-if="invoice.projectName" class="mt-1 text-xs text-slate-500">
            Project: {{ invoice.projectName }}
          </p>
        </div>
        <div class="space-y-1 text-xs text-slate-600 sm:text-right">
          <p><span class="text-slate-400">Issued: </span>{{ date(invoice.createdAt) }}</p>
          <p><span class="text-slate-400">Due: </span>{{ date(invoice.dueDate) }}</p>
          <p><span class="text-slate-400">Currency: </span>{{ invoice.currency }}</p>
        </div>
      </section>

      <table class="w-full border-collapse text-sm">
        <thead>
          <tr
            class="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"
          >
            <th class="py-2 pr-2">Description</th>
            <th class="px-2 py-2 text-center">Qty</th>
            <th class="px-2 py-2 text-right">Rate</th>
            <th class="py-2 pl-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in invoice.items" :key="index" class="border-b border-slate-100">
            <td class="py-2.5 pr-2 text-slate-800">{{ item.description }}</td>
            <td class="px-2 py-2.5 text-center tabular-nums text-slate-600">{{ item.quantity }}</td>
            <td class="px-2 py-2.5 text-right tabular-nums text-slate-600">
              {{ money(item.rate) }}
            </td>
            <td class="py-2.5 pl-2 text-right font-medium tabular-nums text-slate-900">
              {{ money(item.amount ?? item.quantity * item.rate) }}
            </td>
          </tr>
        </tbody>
      </table>

      <section class="mt-6 flex justify-end">
        <dl class="w-full max-w-xs space-y-1.5 text-sm">
          <div class="flex justify-between text-slate-600">
            <dt>Subtotal</dt>
            <dd>{{ money(invoice.subtotal) }}</dd>
          </div>
          <div class="flex justify-between text-slate-600">
            <dt>Tax</dt>
            <dd>{{ money(invoice.tax) }}</dd>
          </div>
          <div
            class="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900"
          >
            <dt>Total</dt>
            <dd>{{ money(invoice.total) }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="invoice.notes" class="mt-8 border-t border-slate-200 pt-4">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Notes</p>
        <p class="mt-1.5 whitespace-pre-wrap text-xs text-slate-600">{{ invoice.notes }}</p>
      </section>
      <p class="mt-8 text-center text-[11px] text-slate-400">Thank you for your business.</p>
    </article>
  </main>
</template>

<style>
@media print {
  body * {
    visibility: hidden !important;
  }
  #invoice-print,
  #invoice-print * {
    visibility: visible !important;
  }
  #invoice-print {
    position: absolute !important;
    inset: 0 !important;
    margin: 0 !important;
    padding: 24px !important;
    border: 0 !important;
    box-shadow: none !important;
  }
  .no-print {
    display: none !important;
  }
}
</style>
