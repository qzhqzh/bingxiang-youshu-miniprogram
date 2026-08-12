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
  {
    id: 'sour_potato_shreds', name: '酸香土豆丝', description: '脆爽开胃的家常快炒。', difficulty: 1, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'potato', amount: 350, unit: 'g' }, { ingredientId: 'vinegar', amount: 12, unit: 'ml' },
      { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '土豆切细丝后用清水洗去表面淀粉。' }, { order: 2, content: '热锅下油，土豆丝大火快速翻炒。' },
      { order: 3, content: '沿锅边加入醋和盐，翻匀后立即出锅。' },
    ],
    cautions: ['土豆丝请确保炒熟。'], unlockRule: { type: 'starter' }, tags: ['快手', '蔬菜', '酸香'],
  },
  {
    id: 'hand_torn_cabbage', name: '手撕包菜', description: '香脆下饭，十几分钟上桌。', difficulty: 1, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'cabbage', amount: 400, unit: 'g' }, { ingredientId: 'garlic', amount: 10, unit: 'g' },
      { ingredientId: 'soy_sauce', amount: 10, unit: 'ml' }, { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' },
    ],
    steps: [
      { order: 1, content: '圆白菜洗净沥干，用手撕成小片。' }, { order: 2, content: '蒜末入油锅炒香。' },
      { order: 3, content: '加入圆白菜大火翻炒，淋生抽后出锅。' },
    ],
    cautions: ['洗净后尽量沥干，避免热油飞溅。'], unlockRule: { type: 'inventory', ingredientIds: ['cabbage', 'garlic'] }, tags: ['快炒', '下饭', '蔬菜'],
  },
  {
    id: 'mushroom_spinach', name: '蘑菇炒菠菜', description: '清鲜柔软的双蔬组合。', difficulty: 1, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'mushroom', amount: 180, unit: 'g' }, { ingredientId: 'spinach', amount: 220, unit: 'g' },
      { ingredientId: 'garlic', amount: 8, unit: 'g' }, { ingredientId: 'cooking_oil', amount: 10, unit: 'ml' },
      { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '蘑菇切片，菠菜洗净切段。' }, { order: 2, content: '蒜末和蘑菇炒至变软。' },
      { order: 3, content: '加入菠菜大火翻炒至熟，加盐调味。' },
    ],
    cautions: ['蘑菇与菠菜均需充分加热。'], unlockRule: { type: 'inventory', ingredientIds: ['mushroom', 'spinach'] }, tags: ['清淡', '蔬菜'],
  },
  {
    id: 'egg_fried_rice', name: '小葱鸡蛋焖饭', description: '大米、鸡蛋和小葱组成的简单主食。', difficulty: 1, durationMin: 35, servings: 2,
    ingredients: [
      { ingredientId: 'rice', amount: 300, unit: 'g' }, { ingredientId: 'egg', amount: 2, unit: 'piece' },
      { ingredientId: 'scallion', amount: 15, unit: 'g' }, { ingredientId: 'cooking_oil', amount: 12, unit: 'ml' },
      { ingredientId: 'soy_sauce', amount: 8, unit: 'ml', optional: true },
    ],
    steps: [
      { order: 1, content: '大米淘洗后按日常水量开始焖煮。' }, { order: 2, content: '鸡蛋炒至刚凝固，小葱切碎。' },
      { order: 3, content: '米饭即将熟时铺入鸡蛋，焖熟后加入小葱和可选生抽拌匀。' },
    ],
    cautions: ['请按所用炊具说明控制水量和加热时间。'], unlockRule: { type: 'prerequisite', recipeIds: ['tomato_scrambled_egg'] }, tags: ['主食', '焖饭', '鸡蛋'],
  },
  {
    id: 'onion_omelette', name: '洋葱煎蛋', description: '甜香柔软，早餐晚餐都合适。', difficulty: 1, durationMin: 12, servings: 2,
    ingredients: [
      { ingredientId: 'onion', amount: 150, unit: 'g' }, { ingredientId: 'egg', amount: 3, unit: 'piece' },
      { ingredientId: 'cooking_oil', amount: 10, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '洋葱切细丝，鸡蛋加盐打散。' }, { order: 2, content: '洋葱炒软后与蛋液混合。' },
      { order: 3, content: '倒回锅中，两面煎至完全凝固。' },
    ],
    cautions: ['蛋液中心需完全凝固。'], unlockRule: { type: 'starter' }, tags: ['早餐', '快手', '鸡蛋'],
  },
  {
    id: 'garlic_shrimp', name: '蒜香虾仁', description: '蒜香明亮、口感弹嫩的快手菜。', difficulty: 2, durationMin: 15, servings: 2,
    ingredients: [
      { ingredientId: 'shrimp', amount: 220, unit: 'g' }, { ingredientId: 'garlic', amount: 15, unit: 'g' },
      { ingredientId: 'cooking_oil', amount: 10, unit: 'ml' }, { ingredientId: 'salt', amount: 2, unit: 'g' },
    ],
    steps: [
      { order: 1, content: '虾仁处理干净并沥干，蒜切末。' }, { order: 2, content: '蒜末小火炒香，加入虾仁。' },
      { order: 3, content: '翻炒至虾仁完全变色熟透，加盐出锅。' },
    ],
    cautions: ['虾仁必须彻底熟透。'], unlockRule: { type: 'prerequisite', recipeIds: ['shrimp_egg'] }, tags: ['海鲜', '快手', '蒜香'],
  },
];
