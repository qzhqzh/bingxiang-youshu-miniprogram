import type { PantryBatch } from '../domain/models';
import { toDateOnly } from '../domain/rules';

const DAY_MS = 86_400_000;

export function createDevPantry(now: number): PantryBatch[] {
  const make = (id: string, ingredientId: string, quantity: number, unit: string, ageDays: number, storageMode: 'room' | 'chilled' | 'frozen'): PantryBatch => ({
    id, ingredientId, quantity, unit, purchasedAt: toDateOnly(now - ageDays * DAY_MS), storageMode,
    status: 'active', createdAt: now - ageDays * DAY_MS, updatedAt: now - ageDays * DAY_MS,
  });
  return [
    make('demo_egg_older', 'egg', 2, 'piece', 20, 'chilled'),
    make('demo_egg_newer', 'egg', 6, 'piece', 2, 'chilled'),
    make('demo_tomato', 'tomato', 450, 'g', 5, 'chilled'),
    make('demo_chicken', 'chicken_breast', 380, 'g', 1, 'chilled'),
    make('demo_broccoli', 'broccoli', 320, 'g', 4, 'chilled'),
    make('demo_salt', 'salt', 500, 'g', 30, 'room'),
    make('demo_oil', 'cooking_oil', 500, 'ml', 30, 'room'),
    make('demo_garlic', 'garlic', 60, 'g', 4, 'room'),
  ];
}
