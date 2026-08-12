import type { Recipe } from '../domain/models';

export const seedRecipes: Recipe[] = [
  {
    id: 'steamed_egg', name: '蒸鸡蛋', description: '细嫩顺滑的家常蒸蛋。', difficulty: 1, durationMin: 15, servings: 1,
    ingredients: [
      { ingredientId: 'egg', amount: 2, unit: 'piece' },
      { ingredientId: 'salt', amount: 1, unit: 'g' },
      { ingredientId: 'sesame_oil', amount: 2, unit: 'ml', optional: true },
    ],
    steps: [
      { order: 1, content: '鸡蛋打入碗中充分搅散。' },
      { order: 2, content: '加入约 180 ml 温水和盐，继续搅匀。' },
      { order: 3, content: '过滤蛋液，盖盘并留出气孔。' },
      { order: 4, content: '水开后中小火蒸 8–10 分钟。', durationMin: 9 },
      { order: 5, content: '关火焖约 2 分钟，可按喜好滴香油。', durationMin: 2 },
    ],
    cautions: ['水温不要过高。', '火力过大容易产生蜂窝。'],
    unlockRule: { type: 'starter' }, tags: ['快手', '鸡蛋', '蒸'],
  },
  {
    id: 'tomato_scrambled_egg', name: '番茄炒蛋', description: '酸甜下饭的经典家常菜。', difficulty: 1, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'egg', amount: 3, unit: 'piece' }, { ingredientId: 'tomato', amount: 300, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 15, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
      { ingredientId: 'sugar', amount: 3, unit: 'g', optional: true },
    ],
    steps: [
      { order: 1, content: '鸡蛋打散，番茄切块。' }, { order: 2, content: '热锅下油，鸡蛋炒至刚凝固后盛出。' },
      { order: 3, content: '番茄炒软出汁，加入盐和可选白糖。' }, { order: 4, content: '倒回鸡蛋快速翻匀后出锅。' },
    ],
    cautions: ['鸡蛋不要炒得过老。', '番茄先炒出汁味道更融合。'],
    unlockRule: { type: 'starter' }, tags: ['快手', '家常'],
  },
  {
    id: 'garlic_broccoli', name: '蒜蓉西兰花', description: '清爽利落的蔬菜料理。', difficulty: 1, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'broccoli', amount: 350, unit: 'g' }, { ingredientId: 'garlic', amount: 12, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 10, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '西兰花切小朵并洗净。' }, { order: 2, content: '沸水焯至断生，捞出沥水。' },
      { order: 3, content: '蒜末爆香，加入西兰花大火翻炒。' }, { order: 4, content: '加盐调味后出锅。' },
    ],
    cautions: ['焯水时间不要过长。'], unlockRule: { type: 'starter' }, tags: ['蔬菜', '清淡'],
  },
  {
    id: 'pan_chicken', name: '香煎鸡胸肉', description: '少配料即可完成的基础肉菜。', difficulty: 1, durationMin: 20, servings: 1,
    ingredients: [
      { ingredientId: 'chicken_breast', amount: 220, unit: 'g' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 8, unit: 'ml' },
    ],
    steps: [
      { order: 1, content: '鸡胸肉从厚处片开，保持厚薄一致。' }, { order: 2, content: '撒盐腌 10 分钟。', durationMin: 10 },
      { order: 3, content: '平底锅少油，中火两面煎熟。' }, { order: 4, content: '静置 2 分钟后切片。' },
    ],
    cautions: ['避免反复翻面。', '请确认中心完全熟透。'], unlockRule: { type: 'starter' }, tags: ['煎', '肉类'],
  },
  {
    id: 'cucumber_scrambled_egg', name: '黄瓜炒蛋', description: '清爽脆嫩的快手菜。', difficulty: 1, durationMin: 12, servings: 2,
    ingredients: [
      { ingredientId: 'egg', amount: 2, unit: 'piece' }, { ingredientId: 'cucumber', amount: 250, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '黄瓜切片，鸡蛋打散。' }, { order: 2, content: '炒熟鸡蛋后盛出。' },
      { order: 3, content: '黄瓜大火快炒并调盐。' }, { order: 4, content: '鸡蛋回锅翻匀。' },
    ],
    cautions: ['黄瓜不要炒太久。'], unlockRule: { type: 'starter' }, tags: ['快手', '清淡'],
  },
  {
    id: 'onion_beef', name: '洋葱炒牛肉', description: '甜香洋葱配滑嫩牛肉。', difficulty: 2, durationMin: 20, servings: 2,
    ingredients: [
      { ingredientId: 'beef_slice', amount: 250, unit: 'g' }, { ingredientId: 'onion', amount: 180, unit: 'g' },
      { ingredientId: 'soy_sauce', amount: 12, unit: 'ml' }, { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' },
    ],
    steps: [
      { order: 1, content: '洋葱切丝，牛肉片用少量生抽抓匀。' }, { order: 2, content: '大火将牛肉快速滑炒至变色后盛出。' },
      { order: 3, content: '洋葱炒至略软。' }, { order: 4, content: '牛肉回锅快速翻匀。' },
    ],
    cautions: ['牛肉不要久炒。'],
    substitutions: [{ fromIngredientId: 'beef_slice', toIngredientId: 'chicken_breast', note: '鸡胸肉需切薄片，并确保中心完全熟透。' }],
    unlockRule: { type: 'inventory', ingredientIds: ['beef_slice', 'onion'] }, tags: ['下饭', '快炒'],
  },
  {
    id: 'shrimp_egg', name: '虾仁滑蛋', description: '鲜嫩快手的虾仁鸡蛋料理。', difficulty: 2, durationMin: 18, servings: 2,
    ingredients: [
      { ingredientId: 'shrimp', amount: 160, unit: 'g' }, { ingredientId: 'egg', amount: 3, unit: 'piece' },
      { ingredientId: 'salt', amount: 2, unit: 'g' }, { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' },
    ],
    steps: [
      { order: 1, content: '虾仁处理干净，鸡蛋打散。' }, { order: 2, content: '虾仁炒至变色。' },
      { order: 3, content: '倒入蛋液，中小火推炒至刚凝固。' },
    ],
    cautions: ['虾仁需彻底熟透。'], unlockRule: { type: 'inventory', ingredientIds: ['shrimp', 'egg'] }, tags: ['海鲜', '鸡蛋'],
  },
  {
    id: 'potato_pork', name: '土豆烧肉', description: '适合一次做两餐的家常炖菜。', difficulty: 2, durationMin: 45, servings: 3,
    ingredients: [
      { ingredientId: 'pork_belly', amount: 350, unit: 'g' }, { ingredientId: 'potato', amount: 400, unit: 'g' },
      { ingredientId: 'soy_sauce', amount: 18, unit: 'ml' }, { ingredientId: 'ginger', amount: 8, unit: 'g' },
      { ingredientId: 'sugar', amount: 8, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '五花肉与土豆切块。' }, { order: 2, content: '五花肉煸出部分油脂，加入姜片。' },
      { order: 3, content: '加入调味料和热水，小火炖 20 分钟。', durationMin: 20 },
      { order: 4, content: '加入土豆继续炖至软烂。', durationMin: 15 },
    ],
    cautions: ['注意锅内水量，避免烧干。'], unlockRule: { type: 'prerequisite', recipeIds: ['tomato_scrambled_egg'] }, tags: ['炖', '家常'],
  },
  {
    id: 'mapo_tofu_simple', name: '家常肉末豆腐', description: '肉末和豆腐的下饭组合。', difficulty: 2, durationMin: 25, servings: 2,
    ingredients: [
      { ingredientId: 'tofu', amount: 350, unit: 'g' }, { ingredientId: 'pork_mince', amount: 120, unit: 'g' },
      { ingredientId: 'soy_sauce', amount: 12, unit: 'ml' }, { ingredientId: 'garlic', amount: 8, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' },
    ],
    steps: [
      { order: 1, content: '豆腐切块，肉末打散。' }, { order: 2, content: '锅中下油，蒜末和肉末炒香。' },
      { order: 3, content: '加入生抽和少量水，放入豆腐。' }, { order: 4, content: '小火烧约 8 分钟收汁。', durationMin: 8 },
    ],
    cautions: ['翻动豆腐时动作轻，避免碎裂。', '肉末需要彻底炒熟。'],
    unlockRule: { type: 'prerequisite', recipeIds: ['pan_chicken'] }, tags: ['下饭', '豆腐'],
  },
  {
    id: 'spinach_egg_soup', name: '菠菜蛋花汤', description: '快速清淡的家常汤品。', difficulty: 1, durationMin: 12, servings: 2,
    ingredients: [
      { ingredientId: 'spinach', amount: 180, unit: 'g' }, { ingredientId: 'egg', amount: 1, unit: 'piece' },
      { ingredientId: 'salt', amount: 2, unit: 'g' }, { ingredientId: 'sesame_oil', amount: 2, unit: 'ml', optional: true },
    ],
    steps: [
      { order: 1, content: '菠菜洗净切段。' }, { order: 2, content: '水烧开后下菠菜。' },
      { order: 3, content: '淋入蛋液形成蛋花。' }, { order: 4, content: '加盐，关火后可滴香油。' },
    ],
    cautions: ['蛋液下锅后不要立刻猛烈搅动。'], unlockRule: { type: 'starter' }, tags: ['汤', '清淡'],
  },
];
