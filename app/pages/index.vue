<script setup lang="ts">
const isUploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

async function uploadFile(file: File) {
  error.value = null;
  isUploading.value = true;
  try {
    const formData = new FormData();
    formData.append('video', file);
    const res = await $fetch<{ hash: string }>('/api/upload', {
      method: 'POST',
      body: formData,
    });
    await navigateTo(`/player/${res.hash}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'upload failed';
  } finally {
    isUploading.value = false;
  }
}

function onPickFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void uploadFile(f);
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void uploadFile(f);
}
</script>

<template>
  <main class="min-h-screen flex items-center justify-center p-8 bg-gray-50">
    <div class="w-full max-w-xl">
      <h1 class="text-3xl font-bold mb-6 text-center">Subcast (Slice 1)</h1>

      <div
        class="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center bg-white hover:border-blue-400 transition"
        @dragover.prevent
        @drop="onDrop"
      >
        <p class="mb-4 text-gray-600">Drop a video file here, or</p>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="isUploading"
          @click="fileInput?.click()"
        >
          {{ isUploading ? 'Uploading…' : 'Choose file' }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="video/*,audio/*"
          class="hidden"
          @change="onPickFile"
        />
      </div>

      <p v-if="error" class="mt-4 text-red-600 text-sm">{{ error }}</p>
    </div>
  </main>
</template>
