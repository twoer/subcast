<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
  icon?: Component;
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-10 text-center">
    <div
      v-if="icon"
      class="mb-3 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground"
    >
      <component :is="icon" class="h-5 w-5" />
    </div>
    <p class="text-sm font-medium text-foreground">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-xs text-xs text-muted-foreground">
      {{ description }}
    </p>
    <slot />
  </div>
</template>
