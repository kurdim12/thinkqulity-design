import type { RunnableFeature } from './types';
import { conceptsFeature } from './concepts';
import { campaignFeature } from './campaign';
import { reportFeature } from './report';
import { gapsFeature } from './gaps';
import { guidelineFeature } from './guideline';
import { storyboardFeature } from './storyboard';
import { audienceFeature } from './audience';
import { strategistFeature } from './strategist';

/**
 * Every agent capability, resolved by `/api/generate/[feature]`.
 * Add a file in this folder, import it, append it here — that is the whole
 * wiring cost of a new feature.
 */
export const FEATURES: readonly RunnableFeature[] = [
  conceptsFeature,
  campaignFeature,
  reportFeature,
  gapsFeature,
  guidelineFeature,
  storyboardFeature,
  audienceFeature,
  strategistFeature,
];

export function getFeature(id: string): RunnableFeature | undefined {
  return FEATURES.find((f) => f.id === id);
}

export function featureIds(): string[] {
  return FEATURES.map((f) => f.id);
}

/** Which features run through the Design Brain — surfaced in Settings. */
export function brainFeatureIds(): string[] {
  return FEATURES.filter((f) => f.hasBrain).map((f) => f.id);
}

export type { RunnableFeature };
