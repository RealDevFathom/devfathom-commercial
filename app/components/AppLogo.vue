<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number;
    title?: string;
    variant?: 'brand' | 'white' | 'dark';
  }>(),
  {
    size: 40,
    title: 'DevFathom',
    variant: 'brand',
  }
);
</script>

<template>
  <svg
    v-if="variant === 'brand'"
    :style="{ width: `${size}px`, height: `${size}px` }"
    viewBox="0 0 64 64"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    :aria-label="title"
  >
    <rect width="64" height="64" rx="14" fill="#0C2E2C" />
    <svg x="15" y="12" width="34" height="40" viewBox="34 33 148 166" fill="none">
      <path
        d="M116 57 L155 97 L110 137 L75 175"
        fill="none"
        stroke="#F7F5EF"
        stroke-width="22"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <rect x="98" y="39" width="38" height="36" rx="12" fill="#F7F5EF" />
      <rect x="135" y="77" width="41" height="41" rx="13" fill="#F7F5EF" />
      <rect x="90" y="118" width="41" height="38" rx="13" fill="#F7F5EF" />
      <rect x="56" y="156" width="37" height="37" rx="12" fill="#F7F5EF" />
      <rect x="40" y="81" width="35" height="34" rx="11" fill="#BC8850" />
    </svg>
  </svg>
  <svg
    v-else
    :style="{ width: `${size}px`, height: `${size}px` }"
    viewBox="34 33 148 166"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    :aria-label="title"
  >
    <path
      d="M116 57 L155 97 L110 137 L75 175"
      fill="none"
      :stroke="variant === 'white' ? '#fff' : '#111110'"
      stroke-width="22"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <rect
      x="98"
      y="39"
      width="38"
      height="36"
      rx="12"
      :fill="variant === 'white' ? '#fff' : '#111110'"
    />
    <rect
      x="135"
      y="77"
      width="41"
      height="41"
      rx="13"
      :fill="variant === 'white' ? '#fff' : '#111110'"
    />
    <rect
      x="90"
      y="118"
      width="41"
      height="38"
      rx="13"
      :fill="variant === 'white' ? '#fff' : '#111110'"
    />
    <rect
      x="56"
      y="156"
      width="37"
      height="37"
      rx="12"
      :fill="variant === 'white' ? '#fff' : '#111110'"
    />
    <rect
      x="40"
      y="81"
      width="35"
      height="34"
      rx="11"
      :fill="variant === 'white' ? '#fff' : '#111110'"
    />
  </svg>
</template>
