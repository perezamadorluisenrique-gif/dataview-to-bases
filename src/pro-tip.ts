import type { Conversion } from './convert.ts';

/**
 * True when at least one query was left unconverted or converted only partly, which is when the one-line Pro
 * tip about checking converted queries may show. A run where everything converted cleanly shows nothing.
 */
export function leftSomeBehind(statuses: ReadonlyArray<Conversion['status']>): boolean {
  return statuses.some((s) => s !== 'full');
}
