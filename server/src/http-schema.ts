import type { FastifySchema } from 'fastify';

const id = { type: 'string', minLength: 1, maxLength: 160 } as const;
const shortText = { type: 'string', minLength: 1, maxLength: 200 } as const;
const positiveNumber = { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 } as const;
const version = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const storageMode = { type: 'string', enum: ['room', 'chilled', 'frozen'] } as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
) {
  return { type: 'object', additionalProperties: false, properties, required, ...extra } as const;
}

const commandBase = {
  mutationId: id,
  deviceId: id,
  householdId: id,
  entityId: id,
  baseVersion: version,
  clientOccurredAt: { type: 'string', minLength: 20, maxLength: 40 },
} as const;
const commandRequired = ['mutationId', 'deviceId', 'householdId', 'command', 'entityId', 'baseVersion', 'payload', 'clientOccurredAt'];

function commandSchema(command: string, payload: unknown) {
  return objectSchema({ ...commandBase, command: { const: command }, payload }, commandRequired);
}

export const schemas = {
  login: { body: objectSchema({ code: { type: 'string', minLength: 1, maxLength: 512 }, deviceId: id }, ['code', 'deviceId']) },
  profile: { body: objectSchema({ displayName: { type: 'string', minLength: 1, maxLength: 30 } }, ['displayName']) },
  createHousehold: {
    body: objectSchema(
      { name: { type: 'string', minLength: 1, maxLength: 30 }, timezone: { type: 'string', minLength: 1, maxLength: 80 } },
      ['name'],
    ),
  },
  updateHousehold: {
    body: objectSchema(
      { name: { type: 'string', minLength: 1, maxLength: 30 }, timezone: { type: 'string', minLength: 1, maxLength: 80 } },
      [],
      { minProperties: 1 },
    ),
  },
  invitation: {
    body: objectSchema({ role: { type: 'string', enum: ['admin', 'member', 'viewer'] }, maxUses: { type: 'integer', minimum: 1, maximum: 10 } }),
  },
  memberRole: {
    body: objectSchema({ role: { type: 'string', enum: ['admin', 'member', 'viewer'] } }, ['role']),
  },
  transferOwnership: { body: objectSchema({ userId: id }, ['userId']) },
  householdQuery: { querystring: objectSchema({ householdId: id }, ['householdId']) },
  pullQuery: {
    querystring: objectSchema(
      { householdId: id, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
      ['householdId'],
    ),
  },
  push: {
    body: {
      oneOf: [
        commandSchema('PurchaseBatch', objectSchema({
          ingredientId: id,
          quantity: positiveNumber,
          unit: shortText,
          purchasedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          storageMode,
          shelfLifeDaysOverride: { type: 'integer', minimum: 1, maximum: 3650 },
          note: { type: 'string', maxLength: 200 },
          shoppingItemId: id,
        }, ['ingredientId', 'quantity', 'unit', 'purchasedAt', 'storageMode'])),
        commandSchema('CompleteCooking', objectSchema({ recipeId: id, servings: positiveNumber }, ['recipeId', 'servings'])),
        commandSchema('AddShoppingItem', objectSchema({
          ingredientId: id, suggestedQuantity: positiveNumber, unit: shortText, sourceRecipeId: id,
        }, ['ingredientId', 'suggestedQuantity', 'unit'])),
        commandSchema('CheckShoppingItem', objectSchema({ checked: { type: 'boolean' } }, ['checked'])),
        commandSchema('RemoveShoppingItem', objectSchema({})),
        commandSchema('DiscardBatch', objectSchema({})),
        commandSchema('UnlockRecipe', objectSchema({ recipeId: id }, ['recipeId'])),
        commandSchema('UpdatePreferences', objectSchema({
          freshnessReminderDays: { type: 'integer', minimum: 1, maximum: 30 },
          defaultStorageMode: storageMode,
          favoriteRecipeIds: { type: 'array', maxItems: 500, uniqueItems: true, items: id },
        }, [], { minProperties: 1 })),
      ],
    },
  },
  migration: {
    body: objectSchema(
      { householdId: id, importBatchId: id, source: { type: 'string', minLength: 2, maxLength: 2_000_000 } },
      ['householdId', 'importBatchId', 'source'],
    ),
  },
} satisfies Record<string, FastifySchema>;
