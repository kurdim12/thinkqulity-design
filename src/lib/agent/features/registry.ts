import type { RunnableFeature } from './types';
import { conceptsFeature } from './concepts';
import { campaignFeature } from './campaign';
import { reportFeature } from './report';

/**
 * Every agent capability, resolved by `/api/generate/[feature]`.
 * Add a file in this folder, import it, append it here — that is the whole
 * wiring cost of a new feature.
 */
export const FEATURES: readonly RunnableFeature[] = [
  conceptsFeature,
  campaignFeature,
  reportFeature,
];

export function getFeature(id: string): RunnableFeature | undefined {
  return FEATURES.find((f) => f.id === id);
}

export function featureIds(): string[] {
  return FEATURES.map((f) => f.id);
}

export type { RunnableFeature };
