from dataclasses import dataclass


@dataclass(frozen=True)
class Requirement:
    ingredient_id: str
    amount: float
    unit: str
    optional: bool = False


@dataclass(frozen=True)
class Recipe:
    id: str
    servings: float
    ingredients: tuple[Requirement, ...]


def r(ingredient_id: str, amount: float, unit: str, optional: bool = False) -> Requirement:
    return Requirement(ingredient_id, amount, unit, optional)


RECIPES = {
    recipe.id: recipe
    for recipe in (
        Recipe("steamed_egg", 1, (r("egg", 2, "piece"), r("salt", 1, "g"), r("sesame_oil", 2, "ml", True))),
        Recipe(
            "tomato_scrambled_egg",
            2,
            (
                r("egg", 3, "piece"),
                r("tomato", 300, "g"),
                r("cooking_oil", 15, "ml"),
                r("salt", 2, "g"),
                r("sugar", 3, "g", True),
            ),
        ),
        Recipe(
            "garlic_broccoli",
            2,
            (r("broccoli", 350, "g"), r("garlic", 12, "g"), r("cooking_oil", 10, "ml"), r("salt", 2, "g")),
        ),
        Recipe("pan_chicken", 1, (r("chicken_breast", 220, "g"), r("salt", 2, "g"), r("cooking_oil", 8, "ml"))),
        Recipe(
            "cucumber_scrambled_egg",
            2,
            (r("egg", 2, "piece"), r("cucumber", 250, "g"), r("cooking_oil", 12, "ml"), r("salt", 2, "g")),
        ),
        Recipe(
            "onion_beef",
            2,
            (r("beef_slice", 250, "g"), r("onion", 180, "g"), r("soy_sauce", 12, "ml"), r("cooking_oil", 12, "ml")),
        ),
        Recipe(
            "shrimp_egg",
            2,
            (r("shrimp", 160, "g"), r("egg", 3, "piece"), r("salt", 2, "g"), r("cooking_oil", 12, "ml")),
        ),
        Recipe(
            "potato_pork",
            3,
            (
                r("pork_belly", 350, "g"),
                r("potato", 400, "g"),
                r("soy_sauce", 18, "ml"),
                r("ginger", 8, "g"),
                r("sugar", 8, "g"),
            ),
        ),
        Recipe(
            "mapo_tofu_simple",
            2,
            (
                r("tofu", 350, "g"),
                r("pork_mince", 120, "g"),
                r("soy_sauce", 12, "ml"),
                r("garlic", 8, "g"),
                r("cooking_oil", 12, "ml"),
            ),
        ),
        Recipe(
            "spinach_egg_soup",
            2,
            (r("spinach", 180, "g"), r("egg", 1, "piece"), r("salt", 2, "g"), r("sesame_oil", 2, "ml", True)),
        ),
        Recipe(
            "sour_potato_shreds",
            2,
            (r("potato", 350, "g"), r("vinegar", 12, "ml"), r("cooking_oil", 12, "ml"), r("salt", 2, "g")),
        ),
        Recipe(
            "hand_torn_cabbage",
            2,
            (r("cabbage", 400, "g"), r("garlic", 10, "g"), r("soy_sauce", 10, "ml"), r("cooking_oil", 12, "ml")),
        ),
        Recipe(
            "mushroom_spinach",
            2,
            (
                r("mushroom", 180, "g"),
                r("spinach", 220, "g"),
                r("garlic", 8, "g"),
                r("cooking_oil", 10, "ml"),
                r("salt", 2, "g"),
            ),
        ),
        Recipe(
            "egg_fried_rice",
            2,
            (
                r("rice", 300, "g"),
                r("egg", 2, "piece"),
                r("scallion", 15, "g"),
                r("cooking_oil", 12, "ml"),
                r("soy_sauce", 8, "ml", True),
            ),
        ),
        Recipe(
            "onion_omelette",
            2,
            (r("onion", 150, "g"), r("egg", 3, "piece"), r("cooking_oil", 10, "ml"), r("salt", 2, "g")),
        ),
        Recipe(
            "garlic_shrimp",
            2,
            (r("shrimp", 220, "g"), r("garlic", 15, "g"), r("cooking_oil", 10, "ml"), r("salt", 2, "g")),
        ),
    )
}

INGREDIENT_UNITS = {
    "egg": "piece",
    "tomato": "g",
    "cucumber": "g",
    "potato": "g",
    "onion": "g",
    "carrot": "g",
    "cabbage": "g",
    "broccoli": "g",
    "spinach": "g",
    "mushroom": "g",
    "chicken_breast": "g",
    "pork_belly": "g",
    "pork_mince": "g",
    "beef_slice": "g",
    "shrimp": "g",
    "tofu": "g",
    "milk": "ml",
    "rice": "g",
    "noodle": "g",
    "flour": "g",
    "soy_sauce": "ml",
    "dark_soy": "ml",
    "vinegar": "ml",
    "salt": "g",
    "sugar": "g",
    "sesame_oil": "ml",
    "cooking_oil": "ml",
    "garlic": "g",
    "ginger": "g",
    "scallion": "g",
}

SHELF_LIFE_DAYS = {
    "egg": {"room": 10, "chilled": 28},
    "tomato": {"room": 5, "chilled": 8},
    "cucumber": {"chilled": 7},
    "potato": {"room": 21, "chilled": 30},
    "onion": {"room": 30, "chilled": 45},
    "carrot": {"chilled": 21},
    "cabbage": {"chilled": 14},
    "broccoli": {"chilled": 5, "frozen": 90},
    "spinach": {"chilled": 3, "frozen": 60},
    "mushroom": {"chilled": 5},
    "chicken_breast": {"chilled": 2, "frozen": 90},
    "pork_belly": {"chilled": 2, "frozen": 90},
    "pork_mince": {"chilled": 1, "frozen": 60},
    "beef_slice": {"chilled": 2, "frozen": 90},
    "shrimp": {"chilled": 1, "frozen": 90},
    "tofu": {"chilled": 3},
    "milk": {"chilled": 7},
    "rice": {"room": 180},
    "noodle": {"room": 180},
    "flour": {"room": 180},
    "soy_sauce": {"room": 180},
    "dark_soy": {"room": 180},
    "vinegar": {"room": 365},
    "salt": {"room": 730},
    "sugar": {"room": 365},
    "sesame_oil": {"room": 180},
    "cooking_oil": {"room": 365},
    "garlic": {"room": 30, "chilled": 45},
    "ginger": {"room": 14, "chilled": 30},
    "scallion": {"chilled": 5},
}

UNLOCK_RULES = {
    "steamed_egg": ("starter", ()),
    "tomato_scrambled_egg": ("starter", ()),
    "garlic_broccoli": ("starter", ()),
    "pan_chicken": ("starter", ()),
    "cucumber_scrambled_egg": ("starter", ()),
    "spinach_egg_soup": ("starter", ()),
    "sour_potato_shreds": ("starter", ()),
    "onion_omelette": ("starter", ()),
    "onion_beef": ("inventory", ("beef_slice", "onion")),
    "shrimp_egg": ("inventory", ("shrimp", "egg")),
    "hand_torn_cabbage": ("inventory", ("cabbage", "garlic")),
    "mushroom_spinach": ("inventory", ("mushroom", "spinach")),
    "potato_pork": ("prerequisite", ("tomato_scrambled_egg",)),
    "mapo_tofu_simple": ("prerequisite", ("pan_chicken",)),
    "egg_fried_rice": ("prerequisite", ("tomato_scrambled_egg",)),
    "garlic_shrimp": ("prerequisite", ("shrimp_egg",)),
}
