export type StorageMode = 'room' | 'chilled' | 'frozen';
export type IngredientCategory =
  | 'vegetable'
  | 'meat'
  | 'eggDairy'
  | 'seafood'
  | 'staple'
  | 'condiment'
  | 'fruit'
  | 'other';
export type Unit = 'g' | 'kg' | 'ml' | 'L' | 'piece' | 'pack' | 'bowl' | 'tbsp' | 'tsp';
export type FreshnessState = 'fresh' | 'good' | 'useSoon' | 'overdue';
export type RecipeStatus = 'locked' | 'unlockable' | 'mastered';

export interface Ingredient {
  id: string;
  name: string;
  category: IngredientCategory;
  defaultUnit: Unit;
  icon: string;
  shelfLifeDays: Partial<Record<StorageMode, number>>;
  aliases?: string[];
}

export interface PantryBatch {
  id: string;
  ingredientId: string;
  quantity: number;
  unit: string;
  purchasedAt: string;
  storageMode: StorageMode;
  shelfLifeDaysOverride?: number;
  note?: string;
  status: 'active' | 'consumed' | 'discarded';
  createdAt: number;
  updatedAt: number;
}

export interface RecipeIngredient {
  ingredientId: string;
  amount: number;
  unit: string;
  optional?: boolean;
  note?: string;
}

export interface RecipeStep {
  order: number;
  title?: string;
  content: string;
  durationMin?: number;
  tips?: string[];
}

export type UnlockRule =
  | { type: 'starter' }
  | { type: 'inventory'; ingredientIds: string[] }
  | { type: 'prerequisite'; recipeIds: string[] };

export interface Recipe {
  id: string;
  name: string;
  description: string;
  difficulty: 1 | 2 | 3;
  durationMin: number;
  servings: number;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  cautions: string[];
  substitutions?: Array<{ fromIngredientId: string; toIngredientId: string; note?: string }>;
  unlockRule: UnlockRule;
  tags: string[];
}

export interface RecipeProgress {
  recipeId: string;
  status: RecipeStatus;
  unlockedAt?: number;
  cookCount: number;
  lastCookedAt?: number;
}

export interface CookingConsumption {
  pantryBatchId: string;
  ingredientId: string;
  quantity: number;
  unit: string;
}

export interface CookingRecord {
  id: string;
  recipeId: string;
  cookedAt: number;
  servings: number;
  consumptions: CookingConsumption[];
}

export interface ShoppingItem {
  id: string;
  ingredientId: string;
  suggestedQuantity: number;
  unit: string;
  sourceRecipeId?: string;
  checked: boolean;
  createdAt: number;
}

export interface AppSettings {
  freshnessReminderDays: number;
  defaultStorageMode: StorageMode;
  favoriteRecipeIds?: string[];
}

export interface AppMeta {
  version: number;
  initializedAt: number;
  purchasedIngredientIds: string[];
}

export interface FreshnessResult {
  state: FreshnessState;
  ageDays: number;
  shelfLifeDays: number;
  remainingDays: number;
  ratio: number;
  expiresAt: number;
}

export interface PantrySummary {
  ingredientId: string;
  quantity: number;
  unit: string;
  batchCount: number;
  storageModes: StorageMode[];
  earliestFreshness: FreshnessResult;
}

export interface IngredientMissing {
  ingredientId: string;
  required: number;
  available: number;
  missing: number;
  unit: string;
}

export interface RecipeAvailability {
  requiredCount: number;
  matchedCount: number;
  availability: number;
  missing: IngredientMissing[];
  optionalMissing: IngredientMissing[];
  canCook: boolean;
}

export interface FefoAllocation extends CookingConsumption {}

export interface CookingPreview {
  recipeId: string;
  servings: number;
  allocations: FefoAllocation[];
  missing: IngredientMissing[];
  optionalMissing: IngredientMissing[];
  canComplete: boolean;
}

export interface CookingCommit {
  batches: PantryBatch[];
  record: CookingRecord;
  progress: RecipeProgress[];
}
