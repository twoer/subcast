/* SPDX-License-Identifier: Apache-2.0 */
import {
  LLM_MODEL_IDS,
  capabilityForModel,
  modelSupportsTask,
  type LlmModelId,
  type LlmTaskKind,
} from '#shared/llmModels';

export const TASK_MODEL_POLICY_ID = 'llm-task-policy-v1';

export interface TaskModelPolicyInput {
  task: LlmTaskKind;
  configuredModel?: LlmModelId;
  installedModels?: readonly LlmModelId[];
  transcriptTokenEstimate?: number;
  preferQuality?: boolean;
  allowQualityRouting?: boolean;
  dryRun?: boolean;
}

export interface TaskModelPolicyDecision {
  modelId: LlmModelId;
  policyId: string;
  task: LlmTaskKind;
  reason: string;
  fallback: boolean;
  dryRun: boolean;
}

export interface TaskModelPolicyDecisionsInput {
  configuredModel?: LlmModelId;
  installedModels?: readonly LlmModelId[];
  allowQualityRouting?: boolean;
  dryRun?: boolean;
}

export const TASK_MODEL_POLICY_TASKS: readonly LlmTaskKind[] = [
  'translate',
  'polish',
  'insight',
  'insight-map',
  'insight-reduce',
];

const FAST_ORDER: readonly LlmModelId[] = ['4b', '8b', '14b'];
const BALANCED_ORDER: readonly LlmModelId[] = ['8b', '4b', '14b'];
const QUALITY_ORDER: readonly LlmModelId[] = ['14b', '8b', '4b'];

function uniqueInstalled(installedModels: readonly LlmModelId[] | undefined): readonly LlmModelId[] | undefined {
  if (installedModels === undefined) return undefined;
  return LLM_MODEL_IDS.filter((id) => installedModels.includes(id));
}

function compatibleFromOrder(
  task: LlmTaskKind,
  candidates: readonly LlmModelId[],
  order: readonly LlmModelId[],
): LlmModelId | undefined {
  return order.find((id) => candidates.includes(id) && modelSupportsTask(id, task));
}

function taskOrder(input: TaskModelPolicyInput): readonly LlmModelId[] {
  if (input.task === 'insight-map') return FAST_ORDER;
  if (input.task === 'insight-reduce' && (input.allowQualityRouting || input.preferQuality)) {
    return QUALITY_ORDER;
  }
  return BALANCED_ORDER;
}

function configuredCompatible(input: TaskModelPolicyInput): boolean {
  return input.configuredModel !== undefined && modelSupportsTask(input.configuredModel, input.task);
}

export function selectTaskModel(input: TaskModelPolicyInput): TaskModelPolicyDecision {
  const installed = uniqueInstalled(input.installedModels);
  const inventoryAvailable = installed !== undefined;
  const candidates = inventoryAvailable ? installed : LLM_MODEL_IDS;
  const configured = input.configuredModel;
  const configuredOk = configuredCompatible(input);
  const dryRun = input.dryRun ?? true;

  if (!inventoryAvailable && configuredOk) {
    return {
      modelId: configured!,
      policyId: TASK_MODEL_POLICY_ID,
      task: input.task,
      reason: 'configured-compatible:inventory-unavailable',
      fallback: false,
      dryRun,
    };
  }

  if (
    configuredOk &&
    input.task !== 'insight-map' &&
    !(input.task === 'insight-reduce' && (input.allowQualityRouting || input.preferQuality))
  ) {
    return {
      modelId: configured!,
      policyId: TASK_MODEL_POLICY_ID,
      task: input.task,
      reason: 'configured-compatible',
      fallback: false,
      dryRun,
    };
  }

  const selected = compatibleFromOrder(input.task, candidates, taskOrder(input));
  if (selected) {
    const tier = capabilityForModel(selected).qualityTier;
    return {
      modelId: selected,
      policyId: TASK_MODEL_POLICY_ID,
      task: input.task,
      reason: `selected-${tier}`,
      fallback: selected !== configured,
      dryRun,
    };
  }

  if (configuredOk) {
    return {
      modelId: configured!,
      policyId: TASK_MODEL_POLICY_ID,
      task: input.task,
      reason: 'configured-compatible:no-installed-alternative',
      fallback: false,
      dryRun,
    };
  }

  throw new Error(`NO_COMPATIBLE_LLM_MODEL:${input.task}`);
}

export function taskModelPolicyDecisions(
  input: TaskModelPolicyDecisionsInput,
): TaskModelPolicyDecision[] {
  return TASK_MODEL_POLICY_TASKS.map((task) =>
    selectTaskModel({
      task,
      configuredModel: input.configuredModel,
      installedModels: input.installedModels,
      allowQualityRouting: input.allowQualityRouting,
      dryRun: input.dryRun ?? true,
    }),
  );
}
