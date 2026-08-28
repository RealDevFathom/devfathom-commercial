import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
const source = readFileSync('src/components/restaurant/restaurant-cameras-console.tsx', 'utf8');
describe('restaurant camera console interaction contract', () => {
  test('gates all camera queries and presents live, playback, and retention controls', () => {
    expect(source).toContain("includes('restaurant-integrations')");
    expect(source).toContain('Open live view');
    expect(source).toContain('Play in panel');
    expect(source).toContain('Save retention');
  });
  test('mounts the single shared wizard binding', () => {
    expect(source.match(/<RestaurantCameraWizard/g)).toHaveLength(1);
    expect(source).toContain('onTest={onTest}');
    expect(source).toContain('onSubmit={onSubmit}');
  });
});
