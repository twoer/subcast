<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Models tab for the settings page (desktop-only).
 *
 * State split with the page:
 *   - draft / settings  → v-model with parent (the page shares these
 *     with the Preferences tab too, so the page owns the authoritative
 *     copy and we expose two-way bindings).
 *   - hardware / saving / savedAt → read-only props from parent.
 *   - modelsData / pendingDelete / modelsErr  → private to this tab;
 *     no other tab cares about them.
 *
 * Saves: direct "Switch" / "Delete" calls hit /api/* themselves and
 * write back to settings/draft via the v-model. The "Save active
 * models" button at the bottom emits `save` so the parent's shared
 * `saveSlice` (which also tracks saving / savedAt for both tabs)
 * handles the actual PUT — keeps the saving / savedAt UX consistent
 * with the Preferences tab.
 */

import {
  Plus, Boxes, RefreshCw, Trash2, AlertTriangle, CheckCircle2,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WHISPER_MODEL_NAMES } from '#shared/whisperModels';
import { LLM_MODELS, type LlmModelId } from '#shared/llmModels';
import { Badge } from '~/components/ui/badge';
import { fmtBytes } from '~/utils/format';
import type { Settings, Hardware } from '@/types/settings';

const draft = defineModel<Settings | null>('draft', { required: true });
const settings = defineModel<Settings | null>('settings', { required: true });

const props = defineProps<{
  hardware: Hardware | null;
  saving: boolean;
  savedAt: number | null;
}>();

const emit = defineEmits<{
  (e: 'save'): void;
}>();

interface WhisperModelRow { name: string; sizeBytes: number }
interface LlmModelRow { name: LlmModelId; filename: string; sizeBytes: number }
interface ModelsResp {
  whisper: { active: string; installed: WhisperModelRow[] };
  llm: { active: LlmModelId | undefined; installed: LlmModelRow[] };
}
type DeleteTarget =
  | { kind: 'whisper'; name: string; sizeBytes: number }
  | { kind: 'llm'; name: LlmModelId; sizeBytes: number };

const { t } = useI18n();
const { set: setActiveModelsCache, refresh: refreshActiveModels } = useActiveModels();

const WHISPER_MODELS = WHISPER_MODEL_NAMES;
const LLM_MODEL_IDS = Object.keys(LLM_MODELS) as LlmModelId[];

const modelsData = ref<ModelsResp | null>(null);
const modelsLoading = ref(false);
const modelsErr = ref<string | null>(null);
const pendingDelete = ref<DeleteTarget | null>(null);

const installedWhisperNames = computed<Set<string>>(
  () => new Set(modelsData.value?.whisper.installed.map((m) => m.name) ?? []),
);

const dirtyModels = computed(() => {
  if (!settings.value || !draft.value) return false;
  return (
    draft.value.whisperModel !== settings.value.whisperModel
    || draft.value.llmModel !== settings.value.llmModel
  );
});

async function loadModels(): Promise<void> {
  modelsLoading.value = true;
  modelsErr.value = null;
  try {
    modelsData.value = await $fetch<ModelsResp>('/api/desktop/models');
  } catch (e) {
    modelsErr.value = e instanceof Error ? e.message : 'failed to load models';
  } finally {
    modelsLoading.value = false;
  }
}

async function setActiveWhisper(name: string): Promise<void> {
  try {
    const res = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: { whisperModel: name },
    });
    settings.value = res.settings;
    draft.value = { ...res.settings };
    if (modelsData.value) modelsData.value.whisper.active = res.settings.whisperModel;
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel);
    void refreshActiveModels();
  } catch (e) {
    modelsErr.value = t('settings.models.switchFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

async function setActiveLlm(name: LlmModelId): Promise<void> {
  try {
    const res = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: { llmModel: name },
    });
    settings.value = res.settings;
    draft.value = { ...res.settings };
    if (modelsData.value) modelsData.value.llm.active = name;
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel);
    void refreshActiveModels();
  } catch (e) {
    modelsErr.value = t('settings.models.switchFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    const url =
      target.kind === 'whisper'
        ? `/api/desktop/whisper/${encodeURIComponent(target.name)}`
        : `/api/desktop/llm/${encodeURIComponent(target.name)}`;
    await $fetch(url, { method: 'DELETE' });
    await loadModels();
  } catch (e) {
    modelsErr.value = t('settings.models.deleteFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

function applyRecommended(): void {
  if (!draft.value || !props.hardware) return;
  draft.value.whisperModel = props.hardware.recommended.whisperModel as Settings['whisperModel'];
  draft.value.llmModel = props.hardware.recommended.llmModel;
}

function resetActiveModelsDraft(): void {
  if (!draft.value || !settings.value) return;
  draft.value.whisperModel = settings.value.whisperModel;
  draft.value.llmModel = settings.value.llmModel;
}

onMounted(() => {
  void loadModels();
});
</script>

<template>
  <div class="space-y-6">
    <Alert v-if="modelsErr" variant="destructive">
      <AlertDescription>{{ modelsErr }}</AlertDescription>
    </Alert>

    <section v-if="draft" class="card space-y-5">
      <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <CheckCircle2 class="h-3.5 w-3.5" />
        {{ t('settings.models.activeTitle') }}
      </h2>

      <div class="space-y-1.5">
        <Label class="text-sm font-medium">{{ t('settings.whisperModel') }}</Label>
        <Select v-model="draft.whisperModel">
          <SelectTrigger class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in WHISPER_MODELS" :key="m" :value="m">
              <span class="font-mono">{{ m }}</span>
              <span
                v-if="hardware && m === hardware.recommended.whisperModel"
                class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
              >{{ t('settings.recommended') }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ t('settings.whisperHint') }}</p>
        <Alert
          v-if="modelsData && !installedWhisperNames.has(draft.whisperModel)"
          variant="destructive"
          class="mt-2"
        >
          <AlertTriangle class="h-4 w-4" />
          <AlertDescription>
            {{ t('settings.models.notInstalledWarn', { name: draft.whisperModel }) }}
          </AlertDescription>
        </Alert>
      </div>

      <div class="space-y-1.5">
        <Label class="text-sm font-medium">{{ t('settings.llmModel') }}</Label>
        <Select v-model="draft.llmModel">
          <SelectTrigger class="w-full">
            <SelectValue :placeholder="t('settings.models.notConfigured')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="id in LLM_MODEL_IDS" :key="id" :value="id">
              <span class="font-mono">{{ id }}</span>
              <span
                v-if="hardware && id === hardware.recommended.llmModel"
                class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
              >{{ t('settings.recommended') }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">
          {{ t('settings.llmHint', { model: hardware?.recommended.llmModel ?? '' }) }}
        </p>
      </div>

      <div class="flex items-center gap-3 border-t border-border/50 pt-4">
        <Button
          :disabled="!dirtyModels || saving"
          @click="emit('save')"
        >
          {{ saving ? t('settings.saving') : dirtyModels ? t('settings.save') : t('settings.saved') }}
        </Button>
        <Button
          v-if="dirtyModels"
          variant="ghost"
          size="sm"
          @click="resetActiveModelsDraft"
        >{{ t('settings.resetDraft') }}</Button>
        <Button
          v-if="hardware"
          variant="ghost"
          size="sm"
          class="ml-auto"
          @click="applyRecommended"
        >{{ t('settings.applyRecommended') }}</Button>
      </div>
    </section>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes class="h-3.5 w-3.5" />
          {{ t('settings.models.whisper') }}
        </h2>
        <div class="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground"
                :aria-label="t('settings.models.refresh')"
                :disabled="modelsLoading"
                @click="loadModels"
              >
                <RefreshCw :class="modelsLoading ? 'animate-spin' : ''" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('settings.models.refresh') }}</TooltipContent>
          </Tooltip>
          <NuxtLink
            to="/setup-wizard?step=1"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Plus class="h-3.5 w-3.5" />
            {{ t('settings.models.downloadMore') }}
          </NuxtLink>
        </div>
      </div>
      <ul
        v-if="modelsData && modelsData.whisper.installed.length > 0"
        class="-mx-2 space-y-1 px-2"
      >
        <li
          v-for="m in modelsData.whisper.installed"
          :key="m.name"
          class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <span class="font-mono text-sm font-medium text-foreground">{{ m.name }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ fmtBytes(m.sizeBytes) }}</span>
            <Badge
              v-if="m.name === modelsData.whisper.active"
              variant="active"
              size="sm"
              class="uppercase tracking-wider"
            >
              <CheckCircle2 class="h-3 w-3" />
              {{ t('settings.models.active') }}
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button
              v-if="m.name !== modelsData.whisper.active"
              variant="secondary"
              size="xs"
              @click="setActiveWhisper(m.name)"
            >{{ t('settings.models.switch') }}</Button>
            <Button
              v-if="m.name !== modelsData.whisper.active"
              variant="ghost"
              size="xs"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="pendingDelete = { kind: 'whisper', name: m.name, sizeBytes: m.sizeBytes }"
            >
              <Trash2 />
              {{ t('settings.models.delete') }}
            </Button>
          </div>
        </li>
      </ul>
      <p
        v-else-if="modelsData"
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.empty') }}</p>
      <p
        v-else
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.loading') }}</p>
    </section>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes class="h-3.5 w-3.5" />
          {{ t('settings.models.llm') }}
        </h2>
        <div class="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground"
                :aria-label="t('settings.models.refresh')"
                :disabled="modelsLoading"
                @click="loadModels"
              >
                <RefreshCw :class="modelsLoading ? 'animate-spin' : ''" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('settings.models.refresh') }}</TooltipContent>
          </Tooltip>
          <NuxtLink
            to="/setup-wizard?step=2"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Plus class="h-3.5 w-3.5" />
            {{ t('settings.models.downloadMore') }}
          </NuxtLink>
        </div>
      </div>

      <ul
        v-if="modelsData && modelsData.llm.installed.length > 0"
        class="-mx-2 space-y-1 px-2"
      >
        <li
          v-for="m in modelsData.llm.installed"
          :key="m.name"
          class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <span class="truncate font-mono text-sm font-medium text-foreground">{{ m.filename }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ fmtBytes(m.sizeBytes) }}</span>
            <Badge
              v-if="m.name === modelsData.llm.active"
              variant="active"
              size="sm"
              class="uppercase tracking-wider"
            >
              <CheckCircle2 class="h-3 w-3" />
              {{ t('settings.models.active') }}
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button
              v-if="m.name !== modelsData.llm.active"
              variant="secondary"
              size="xs"
              @click="setActiveLlm(m.name)"
            >{{ t('settings.models.switch') }}</Button>
            <Button
              v-if="m.name !== modelsData.llm.active"
              variant="ghost"
              size="xs"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="pendingDelete = { kind: 'llm', name: m.name, sizeBytes: m.sizeBytes }"
            >
              <Trash2 />
              {{ t('settings.models.delete') }}
            </Button>
          </div>
        </li>
      </ul>
      <p
        v-else-if="modelsData"
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.emptyLlm') }}</p>
      <p
        v-else
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.loading') }}</p>
    </section>

    <Dialog
      :open="pendingDelete !== null"
      @update:open="(v: boolean) => { if (!v) pendingDelete = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('settings.models.deleteTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{
              t('settings.models.deleteDesc', {
                name: pendingDelete?.name ?? '',
                size: pendingDelete ? fmtBytes(pendingDelete.sizeBytes) : '',
              })
            }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingDelete = null">
            {{ t('settings.models.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmDelete">
            <Trash2 class="h-4 w-4" />
            {{ t('settings.models.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
