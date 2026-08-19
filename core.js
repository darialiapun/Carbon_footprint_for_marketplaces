/**
 * EcoCore — общая логика для всех маркетплейсов: коэффициенты материалов/категорий,
 * расчёт эмиссии, оценка веса, рендер виджета и оркестрация конвейера.
 * НЕ содержит ничего специфичного для конкретного сайта (селекторов, DOM-скрапинга) —
 * это задача адаптеров (например ozon.js), которые передают свои функции в
 * EcoCore.createRunner(adapter).
 */
(function () {
    "use strict";

    const MONTH_LIMIT_CO2 = 166;
    const LDPE_DENSITY = 920;
    const LDPE_THICKNESS_M = 0.00006;
    const LDPE_EMISSION_FACTOR = 2.11;
    const FALLBACK_WEIGHTS = {
        // Одежда разбита по типу вещи — трусы и штаны не могут весить одинаково.
        underwear: 0.08,    // белье, трусы, носки
        tshirt: 0.18,       // футболки, поло, лонгсливы, майки
        shirt: 0.22,        // рубашки, блузы
        skirt: 0.25,        // юбки
        shorts: 0.3,        // шорты
        dress: 0.32,        // платья, сарафаны
        pants: 0.5,         // брюки, джинсы, легинсы
        clothing: 0.4,      // прочая одежда без явного подтипа
        outerwear: 1.5,
        // Обувь разбита по подтипам — пара туфель и пара сапог отличаются в разы.
        shoes_light: 0.5,   // туфли, лоферы, мокасины, сандалии, сланцы, балетки
        shoes_sport: 0.8,   // кроссовки, кеды
        shoes_boots: 1.3,   // ботинки, сапоги
        electronics: 1.2,
        beauty: 0.25,
        home_chem: 1.0,
        furniture: 15.0,
        food: 0.5,
        auto_parts: 0.2,
        bags: 0.6,          // рюкзаки, сумки, чемоданы — сам предмет лёгкий, хоть и объёмный
        default: 0.7
    };

    /**
     * Эффективная плотность категории: кг товара на м³ УПАКОВКИ (объём коробки
     * по габаритам с маркетплейса), а не только самого товара — коробка редко
     * заполнена под завязку. Оценка по тому, из чего обычно состоят товары
     * категории и насколько плотно они обычно упакованы. Как и остальные
     * коэффициенты в файле — инженерная эвристика, не сертифицированные данные.
     */
    const CATEGORY_DENSITY_KG_PER_M3 = {
        underwear: 150,
        tshirt: 150,
        shirt: 150,
        skirt: 150,
        shorts: 150,
        dress: 150,
        pants: 150,
        clothing: 150,      // мягкое, много воздуха в сложенном виде
        outerwear: 120,     // объемное, но часто сжато в упаковке
        shoes_light: 90,    // внутри обуви много пустоты
        shoes_sport: 90,
        shoes_boots: 100,   // плотнее за счет высокого голенища
        electronics: 250,   // корпус + пустоты под защитную пену
        beauty: 400,        // бутылочки/тюбики, но с зазорами в коробке
        home_chem: 800,     // жидкость почти вплотную к стенкам тары
        furniture: 150,     // ДСП/картон с большими пустотами (короба плоской упаковки)
        food: 450,          // смесь сухих (легких) и жидких/твердых (тяжелых) товаров
        auto_parts: 180,    // пластик/металл, но часто полые детали (как фильтр)
        bags: 50,           // рюкзак/сумка объёмные, но внутри почти пусто (мягкий каркас)
        default: 200
    };

    /* Коэффициенты материалов: кг CO2 на кг материала */
    const MATERIAL_COEFFICIENTS = {
        "натуральный шелк": 35,
        кашемир: 55,
        овчина: 45,
        // Натуральная кожа — один из самых "тяжелых" по следу материалов
        // (в основном из-за животноводства, не самой выделки).
        нубук: 110,
        замша: 110,
        кожа: 110,
        шерсть: 34,
        акрил: 12,
        нейлон: 11,
        флис: 11.5,
        велюр: 11.5,
        вельвет: 12,
        деним: 10.5,
        эластан: 10.5,
        лайкра: 10.5,
        спандекс: 10.5,
        полиэстер: 9.1,
        полиэфир: 9.1,
        лавсан: 9.1,
        атлас: 9,
        муслин: 8.5,
        батист: 8.5,
        хлопок: 8.4,
        экокожа: 7,
        лен: 4.5,
        конопля: 4,
        бамбук: 3.8,
        вискоза: 3.9,
        резина: 3.8,
        каучук: 3.8,
        тенсель: 3.2,
        пластик: 3,
        металл: 2.5,
        стекло: 1.2,
        бумага: 1.1,
        картон: 0.9,
        дерево: 0.8
    };

    /** Упорядоченные пары [слово, кг CO2/кг] — сначала более длинные совпадения. */
    const MATERIAL_ENTRIES = Object.entries(MATERIAL_COEFFICIENTS).sort(
        (a, b) => b[0].length - a[0].length
    );

    /**
     * Средние коэффициенты по категориям: кг CO2e на кг товара .
     * Порядок важен: сначала более узкие категории.
     */
    const CATEGORY_RULES = [
        { re: /книг|канц|канцеляр|ежедневник|альбом\s*для/, kgPerKg: 1.5 },
        { re: /продукты\s*питания|гастроном|супермаркет|кулинар|корм|консерв|колбас|сыр\b|хлеб|овощ|фрукт/, kgPerKg: 13 },
        { re: /красот|космет|парф|уход|гигиен|шампунь|крем|маск|сыворотк|лицо|дезодорант/, kgPerKg: 5 },
        { re: /детск|игрушк|коляск|подгузник/, kgPerKg: 5 },
        { re: /бытовая\s*химия|стирк|чистящ|отбелив|моющ|освежитель/, kgPerKg: 3 },
        { re: /автотовар|автомоб|шин(а|ы)\b|моторн(ое|ые)\s*масл/, kgPerKg: 10 },
        {
            re: /бытовая\s*техника|встраиваемая|холодильник|стиральн|посудомоечн|духовк|фен|плита\b|пылесос|блендр|телевиз/,
            kgPerKg: 20
        },
        {
            re: /электрон|компьютер|ноутбук|смартфон|планшет|наушник|монитор|видеокарт|процессор|фотоаппарат|клавиатур/,
            kgPerKg: 60
        },
        { re: /спорт|туризм|тренаж|велосипед|палатк/, kgPerKg: 9 },
        { re: /обувь|кроссов|ботинк|туфл|сапог|босоножк|кеды|сланцы/, kgPerKg: 16 },
        { re: /мебель|матрас|шкаф|диван|кресл|подушк|чемодан|стол\b|стул\b/, kgPerKg: 4 },
        { re: /одежд|белье|трикотаж|куртк|плать|футбол|брюк|шорты|юбк|пальто|ремень|ремни|пояс\b|сумка|рюкзак|кошелек|аксессуар|бижутерия|зонт\b/, kgPerKg: 12 },
        { re: /корм|животн|наполнит|собак|кот/, kgPerKg: 8.6 }
    ];

    const DEFAULT_CATEGORY_KG_PER_KG = 12;
    const HEROES = [
        { name: "пингвина", image: "penguin.png", lifetimeKg: 62 },
        { name: "моржа", image: "walrus.png", lifetimeKg: 78 },
        { name: "морской черепахи", image: "turtle.png", lifetimeKg: 88 },
        { name: "снежного барса", image: "leopard.png", lifetimeKg: 104 },
        { name: "белого медведя", image: "bear.png", lifetimeKg: 120 }
    ];

    /** Поставь false, когда экстракция станет надежной и логи больше не нужны. */
    const DEBUG_ECO = true;

    /** Печатает пронумерованный шаг конвейера в консоль DevTools. */
    function logStep(step, title, payload) {
        if (!DEBUG_ECO) return;
        console.log(
            `%c[Eco-Tracker] Шаг ${step}: ${title}`,
            "color:#1e8e3e;font-weight:bold;"
        );
        if (payload !== undefined) console.log(payload);
    }

    function parseNumber(raw) {
        if (!raw) return null;
        const normalized = String(raw).replace(/\s+/g, "").replace(",", ".");
        const value = Number.parseFloat(normalized);
        return Number.isFinite(value) ? value : null;
    }

    const MAX_REASONABLE_WEIGHT_KG = 120;
    const MIN_REASONABLE_WEIGHT_KG = 0.005;

    function normalizeWeightKg(kg) {
        if (!Number.isFinite(kg)) return null;
        if (kg < MIN_REASONABLE_WEIGHT_KG || kg > MAX_REASONABLE_WEIGHT_KG) return null;
        return kg;
    }

    function parseWeightToKg(weightText) {
        if (!weightText) return null;
        // Берем только значения с единицами измерения, чтобы не ловить артикулы/ID.
        const match = weightText.match(/(\d+(?:[.,]\d+)?)(?:\s*)(кг|г|kg|g|л|l|мл|ml)\b/i);
        if (!match) return null;
        const value = parseNumber(match[1]);
        if (value === null) return null;
        const unit = (match[2] || "").toLowerCase();
        if (unit.includes("кг") || unit === "kg") return normalizeWeightKg(value);
        if (unit === "л" || unit === "l") return normalizeWeightKg(value); // 1л ~ 1кг
        if (unit === "мл" || unit === "ml") return normalizeWeightKg(value / 1000);
        return normalizeWeightKg(value / 1000); // г
    }

    function parseDimensionsMm(dimText) {
        if (!dimText) return null;
        const nums = dimText
            .replace(/,/g, ".")
            .match(/\d+(?:\.\d+)?/g);
        if (!nums || nums.length < 3) return null;

        const [lengthMm, widthMm, heightMm] = nums.slice(0, 3).map(Number);
        if (![lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n))) return null;

        return { lengthMm, widthMm, heightMm };
    }

    function inferWeightFromTitle(productName) {
        if (!productName) return null;
        const t = productName.toLowerCase();
        const m = t.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|kg|g|л|l|мл|ml)\b/i);
        if (!m) return null;
        return parseWeightToKg(`${m[1]} ${m[2]}`);
    }

    function detectCategoryBucket(categoryText, productName) {
        const hay = `${categoryText} ${productName}`.toLowerCase();
        if (/верхн.*одежд|пуховик|парка|пальто|плащ|шуб|дубленк|ветровк/.test(hay)) return "outerwear";
        if (/ботинк|сапог|дутик/.test(hay)) return "shoes_boots";
        if (/кроссов|кеды|сникерс/.test(hay)) return "shoes_sport";
        if (/обувь|туфл|лофер|мокасин|сланц|сандал|шлеп|балетк/.test(hay)) return "shoes_light";
        if (/белье|трус|носк|боксер|плавк/.test(hay)) return "underwear";
        if (/футболк|поло\b|лонгслив|майка|топ\b/.test(hay)) return "tshirt";
        if (/рубашк|блуз/.test(hay)) return "shirt";
        if (/юбк/.test(hay)) return "skirt";
        if (/шорт/.test(hay)) return "shorts";
        if (/плать|сарафан/.test(hay)) return "dress";
        if (/брюк|джинс|легинс|штаны/.test(hay)) return "pants";
        if (/одежд|куртк/.test(hay)) return "clothing";
        if (/рюкзак|сумк|чемодан|портфел|несессер/.test(hay)) return "bags";
        if (/космет|крем|сыворотк|шампун|гель|маск|парф|дезодорант/.test(hay)) return "beauty";
        if (/бытовая\s*химия|моющ|чистящ|таблетк.*посудомо/.test(hay)) return "home_chem";
        if (/бытовая\s*техника|фен|пылесос|чайник|блендер|мультивар|утюг|электрон|смартфон|телефон|ноутбук|планшет|наушник/.test(hay)) return "electronics";
        if (/мебель|диван|шкаф|кресл|стол|стул|матрас/.test(hay)) return "furniture";
        if (/продукты\s*питания|гастроном|супермаркет|кулинар|корм|консерв|колбас|сыр|хлеб|овощ|фрукт/.test(hay)) return "food";
        if (/автотовар|запчаст.*авто|фильтр.*(авто|салон)|автомоб/.test(hay)) return "auto_parts";
        return "default";
    }

    function inferFallbackWeightKg(categoryText, productName) {
        const titleWeight = inferWeightFromTitle(productName);
        if (titleWeight && titleWeight > 0) return titleWeight;
        const bucket = detectCategoryBucket(categoryText, productName);
        return FALLBACK_WEIGHTS[bucket] || FALLBACK_WEIGHTS.default;
    }

    /**
     * Сколько штук товара в одной карточке/упаковке (например "Комплект трусов, 3 шт").
     * FALLBACK_WEIGHTS — это вес ОДНОЙ штуки, поэтому для комплектов его нужно умножать.
     * Реальный вес с сайта и оценку по объёму НЕ умножаем — они и так про физическую
     * упаковку целиком (реальный вес — это вес посылки, объём — размеры реальной коробки).
     */
    function extractPackQuantity(pairs, productName) {
        const keyRe = /единиц\s+в\s+(одном\s+)?товаре|количество\s+в\s+упаковке|штук\s+в\s+упаковке|количество\s+штук/i;
        for (const [key, value] of Object.entries(pairs)) {
            if (!keyRe.test(key)) continue;
            const n = parseNumber(value);
            if (n && n > 1) return Math.round(n);
        }
        // Фоллбэк: ищем "3 шт" / "комплект из 3" прямо в названии товара.
        // Важно: \b не работает с кириллицей в JS (\w = только латиница), поэтому
        // вместо границы слова используем негативный lookahead на русскую букву.
        const fromTitle =
            productName.match(/(\d+)\s*шт(?![а-яёa-z])/i) ||
            productName.match(/комплект\s*из\s*(\d+)/i);
        if (fromTitle) {
            const n = parseNumber(fromTitle[1]);
            if (n && n > 1) return Math.round(n);
        }
        return 1;
    }

    /**
     * Оценка веса по габаритам: объём коробки (Д×Ш×В) × эффективная плотность
     * категории. Используется только когда реального веса нет, но есть размеры —
     * это точнее, чем один фиксированный вес на всю категорию (fallback).
     */
    function estimateWeightFromVolumeKg(dimensions, bucket) {
        if (!dimensions) return null;
        const volumeM3 =
            (dimensions.lengthMm / 1000) *
            (dimensions.widthMm / 1000) *
            (dimensions.heightMm / 1000);
        if (!Number.isFinite(volumeM3) || volumeM3 <= 0) return null;
        const density = CATEGORY_DENSITY_KG_PER_M3[bucket] || CATEGORY_DENSITY_KG_PER_M3.default;
        return normalizeWeightKg(volumeM3 * density);
    }

    /**
     * У части товаров нет единого поля "Размеры/Габариты" — вместо этого три
     * отдельных: "Длина, мм", "Ширина, мм", "Высота, мм" (как у автозапчастей).
     */
    function extractDimensionsFromSeparateFields(pairs) {
        const readMm = (re) => {
            for (const [key, value] of Object.entries(pairs)) {
                if (!re.test(key)) continue;
                const n = parseNumber(value);
                if (n !== null) return n;
            }
            return null;
        };
        const lengthMm = readMm(/^длина(\s|,|$)/i);
        const widthMm = readMm(/^ширина(\s|,|$)/i);
        const heightMm = readMm(/^(высота|глубина)(\s|,|$)/i);
        if (![lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n))) return null;
        return { lengthMm, widthMm, heightMm };
    }

    function getPairValue(pairs, keyRe) {
        for (const [k, v] of Object.entries(pairs)) {
            if (keyRe.test(k)) return v;
        }
        return null;
    }

    function extractWeightFromPairs(pairs) {
        for (const [key, value] of Object.entries(pairs)) {
            if (!/\bвес\b|\bмасса\b/i.test(key)) continue;

            // 1) Если единица есть в значении — парсим напрямую.
            const direct = parseWeightToKg(value);
            if (direct) return direct;

            // 2) Если значение только число — берём единицу из ключа.
            const numeric = parseNumber(value);
            if (numeric === null) continue;

            if (/\bкг\b|kg/i.test(key)) {
                const asKg = normalizeWeightKg(numeric);
                if (asKg) return asKg;
            }
            if (/\bг\b|грам/i.test(key)) {
                const asG = normalizeWeightKg(numeric / 1000);
                if (asG) return asG;
            }
            if (/\bмл\b|ml/i.test(key)) {
                const asMl = normalizeWeightKg(numeric / 1000);
                if (asMl) return asMl;
            }
            if (/\bл\b|[^м]l\b/i.test(key)) {
                const asL = normalizeWeightKg(numeric);
                if (asL) return asL;
            }
        }
        return null;
    }

    /** Текст для поиска материала: пары «Состав» / «Материал» + типичные вхождения в полном тексте страницы. */
    function buildCompositionBlob(pairs, fullText) {
        const chunks = [];
        for (const key of Object.keys(pairs)) {
            if (/состав|материал/.test(key)) chunks.push(pairs[key]);
        }
        const patterns = [
            /состав[\s:]*([^\n]{1,500})/gi,
            /материал(?:\s+(?:верха|подкладки|изделия))?[\s:]*([^\n]{1,500})/gi
        ];
        for (const re of patterns) {
            let m;
            while ((m = re.exec(fullText)) !== null) {
                if (m[1]) chunks.push(m[1].trim());
            }
        }
        const joined = chunks.join(" | ");
        return joined.length > 2500 ? joined.slice(0, 2500) : joined;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function hasWholeWord(haystack, token) {
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(token)}([^\\p{L}\\p{N}]|$)`, "iu");
        return pattern.test(haystack);
    }

    function matchMaterialCoefficient(text) {
        const haystack = (text || "").toLowerCase();
        if (!haystack.trim()) return null;
        for (const [keyword, coeff] of MATERIAL_ENTRIES) {
            const token = keyword.toLowerCase();
            if (hasWholeWord(haystack, token)) {
                return { keyword, coeff };
            }
        }
        return null;
    }

    function matchCategoryCoefficient(text) {
        const hay = text.toLowerCase();
        for (const rule of CATEGORY_RULES) {
            if (rule.re.test(hay)) return rule.kgPerKg;
        }
        return DEFAULT_CATEGORY_KG_PER_KG;
    }

    /**
     * Локальная цепочка:
     * 1) если найден материал -> вес * материал
     * 2) иначе -> вес * категория
     */
    function computeComprehensiveEmission(data) {
        const realWeight = data.weightKg || null;
        // Приоритет для веса "не по этикетке": сперва оценка по объёму упаковки
        // (габариты × плотность категории), и только если габаритов нет вообще —
        // плоский fallback-вес по категории.
        const volumeWeight = data.volumeEstimatedWeightKg || null;
        const fallbackWeight = volumeWeight || data.fallbackWeightKg || null;
        const weightEstimationMethod = realWeight
            ? "реальный (со страницы)"
            : volumeWeight
            ? "оценка по объёму × плотность категории"
            : fallbackWeight
            ? "среднее по категории (fallback)"
            : "нет данных";
        // Для материала используем только состав/характеристики.
        // Название товара часто дает ложные совпадения (пример: "зеленый" -> "лен").
        const materialBlob = `${data.compositionText}`.trim();
        const materialHit = matchMaterialCoefficient(materialBlob);
        const hasMaterial = Boolean(materialHit);
        const hasRealWeight = Boolean(realWeight);
        const hasFallbackWeight = Boolean(fallbackWeight);

        if (!hasRealWeight && !hasFallbackWeight) {
            return {
                emission: 0,
                usedWeight: 0,
                usedCoefficient: 0,
                source: "none",
                isFallbackWeight: true,
                isMaterialMatch: false,
                weightEstimationMethod,
                branch: "none"
            };
        }

        // 1) реальный вес * реальный материал
        if (hasRealWeight && hasMaterial) {
            return {
                emission: realWeight * materialHit.coeff,
                usedWeight: realWeight,
                usedCoefficient: materialHit.coeff,
                source: materialHit.keyword,
                isFallbackWeight: false,
                isMaterialMatch: true,
                weightEstimationMethod,
                branch: "1_real_weight_real_material"
            };
        }

        // 2.1) примерный вес * реальный материал
        if (!hasRealWeight && hasMaterial && hasFallbackWeight) {
            return {
                emission: fallbackWeight * materialHit.coeff,
                usedWeight: fallbackWeight,
                usedCoefficient: materialHit.coeff,
                source: materialHit.keyword,
                isFallbackWeight: true,
                isMaterialMatch: true,
                weightEstimationMethod,
                branch: "2_1_fallback_weight_real_material"
            };
        }

        const catCoeff = matchCategoryCoefficient(`${data.category} ${data.productName}`);

        // 2.2) реальный вес * категория
        if (hasRealWeight && !hasMaterial) {
            return {
                emission: realWeight * catCoeff,
                usedWeight: realWeight,
                usedCoefficient: catCoeff,
                source: "категория",
                isFallbackWeight: false,
                isMaterialMatch: false,
                weightEstimationMethod,
                branch: "2_2_real_weight_category"
            };
        }

        // 3) примерный вес (объём или fallback) * категория
        const finalWeight = fallbackWeight || realWeight || 0;
        if (!finalWeight) {
            return {
                emission: 0,
                usedWeight: 0,
                usedCoefficient: 0,
                source: "none",
                isFallbackWeight: true,
                isMaterialMatch: false,
                weightEstimationMethod,
                branch: "none"
            };
        }

        return {
            emission: finalWeight * catCoeff,
            usedWeight: finalWeight,
            usedCoefficient: catCoeff,
            source: "категория",
            isFallbackWeight: true,
            isMaterialMatch: false,
            weightEstimationMethod,
            branch: volumeWeight ? "3_volume_estimated_weight_category" : "3_fallback_weight_category"
        };
    }

    function calcPackagingWeightKg(dimensions) {
        if (!dimensions) return 0;
        const a = dimensions.lengthMm / 1000;
        const b = dimensions.widthMm / 1000;
        const c = dimensions.heightMm / 1000;
        const surfaceArea = 2 * ((a * b) + (b * c) + (a * c));
        return surfaceArea * LDPE_THICKNESS_M * LDPE_DENSITY;
    }

    function calcPackagingEmissionKg(dimensions) {
        const packagingWeightKg = calcPackagingWeightKg(dimensions);
        return packagingWeightKg * LDPE_EMISSION_FACTOR;
    }

    function calcProgressColor(percentage) {
        const clamped = Math.max(0, Math.min(1, percentage));
        const hue = 120 - (120 * clamped);
        return `hsl(${hue}, 90%, 48%)`;
    }

    function pickHero() {
        const index = Math.floor(Math.random() * HEROES.length);
        return HEROES[index];
    }

    function resolveHeroImageUrl(fileName) {
        return chrome.runtime.getURL(`animals/${fileName}`);
    }

    function getCurrentMonthLabel() {
        const month = new Date().toLocaleString("ru-RU", { month: "long" });
        return month.toUpperCase();
    }

    function upsertWidget(target) {
        // Проверяем по ID, чтобы не плодить дубликаты
        const existing = document.getElementById("eco-widget-container");
        if (existing) return existing;

        const container = document.createElement("div");
        container.id = "eco-widget-container";

        // Используем append, чтобы виджет встал ВНИЗУ блока (под ценой)
        target.append(container);
        return container;
    }

    function renderWidget(target, payload) {
        const widget = upsertWidget(target);

        const progressValue = Math.min((payload.totalFootprint / MONTH_LIMIT_CO2) * 100, 100);
        const progressColor = calcProgressColor(progressValue / 100);
        const heroPercent = Math.min((payload.totalFootprint / payload.hero.lifetimeKg) * 100, 100);
        const monthLabel = getCurrentMonthLabel();
        const heroImageUrl = resolveHeroImageUrl(payload.hero.image);

        const radius = 32;
        const circumference = 2 * Math.PI * radius;
        const dashOffset = circumference * (1 - progressValue / 100);

        // Настройки размеров для героев (пингвин и медведь компактнее)
        const heroName = payload.hero.name.toLowerCase();
        const isSmallHero = heroName.includes("пингвина") || heroName.includes("медведя");

        const heroImageSize = isSmallHero ? "110px" : "140px";
        const heroImageTop = isSmallHero ? "-30px" : "-55px";
        const heroImageRight = isSmallHero ? "10px" : "-10px";

        widget.innerHTML = `
            <style>
                /* Точка вставки на некоторых сайтах (например WB) сама является
                   flex/grid-контейнером — без этого наш блок сжимается вбок вместо
                   того чтобы встать отдельной строкой на всю ширину. */
                #eco-widget-container {
                    display: block !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    flex: 1 1 100% !important;
                    box-sizing: border-box !important;
                }

                #eco-widget-container .eco-widget-card {
                    padding: 16px 16px 12px 16px;
                    border: 1px solid #e0e0e0;
                    border-radius: 16px;
                    background: white;
                    font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
                }

                #eco-widget-container .eco-header {
                    font-weight: bold;
                    font-size: 22px !important;
                    color: #2c3e50 !important;
                    margin-bottom: 16px;
                }

                #eco-widget-container .eco-stats-row { display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                #eco-widget-container .eco-month-label {
                    font-size: 14px !important;
                    color: #7f8c8d !important;
                    text-transform: uppercase;
                    font-weight: 600 !important;
                }
                #eco-widget-container .eco-co2-number {
                    font-size: 24px !important;
                    font-weight: bold !important;
                    color: #2c3e50 !important;
                }

                #eco-widget-container .eco-hero-box {
                    display: flex;
                    align-items: flex-start;
                    margin-top: 12px;
                    position: relative;
                    min-height: 55px;
                }

                #eco-widget-container .eco-hero-text-block {
                    flex: 1;
                    font-size: 13px !important;
                    color: #5d6d7e !important;
                    line-height: 1.4 !important;
                    font-weight: 600 !important;
                    padding-right: 50px;
                    z-index: 1;
                }

                #eco-widget-container .eco-hero-image {
                    position: absolute;
                    right: ${heroImageRight};
                    top: ${heroImageTop};
                    width: ${heroImageSize};
                    height: ${heroImageSize};
                    object-fit: contain;
                    mix-blend-mode: multiply;
                    filter: drop-shadow(1px 1px 0 white) drop-shadow(-1px -1px 0 white) drop-shadow(1px -1px 0 white) drop-shadow(-1px 1px 0 white);
                    z-index: 10;
                    pointer-events: none;
                }
            </style>

            <div class="eco-widget-card">
                <div class="eco-header">Углеродный след</div>

                <div class="eco-stats-row">
                    <div style="position: relative; width: 80px; height: 80px;">
                        <svg width="80" height="80" viewBox="0 0 80 80">
                            <circle cx="40" cy="40" r="32" fill="none" stroke="#f0f0f0" stroke-width="6" />
                            <circle cx="40" cy="40" r="32" fill="none" stroke="${progressColor}" stroke-width="6"
                                    stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                                    stroke-linecap="round" transform="rotate(-90 40 40)" />
                        </svg>
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-weight: bold; font-size: 14px;">
                            ${progressValue.toFixed(1)}%
                        </div>
                    </div>

                    <div class="eco-main-value">
                        <div class="eco-month-label">${monthLabel}</div>
                        <div class="eco-co2-number">${payload.totalFootprint.toFixed(2)} кг CO₂</div>
                    </div>
                </div>

                <div class="eco-hero-box">
                    <div class="eco-hero-text-block">
                        Это ${heroPercent.toFixed(1)}% жизненного<br>
                        следа ${payload.hero.name}
                    </div>
                    <img class="eco-hero-image" src="${heroImageUrl}" onerror="this.style.display='none'">
                </div>
            </div>
        `;
    }

    /**
     * Создаёт "движок" виджета для конкретного сайта: SPA-навигация, MutationObserver,
     * дебаунс перерисовки и весь конвейер шагов (сбор -> расчёт -> рендер) — общие для
     * всех маркетплейсов. Site-адаптер отвечает только за то, ЧТО и ГДЕ искать в DOM.
     *
     * adapter должен реализовать:
     * - isProductPage(): boolean
     * - findInjectionTarget(): Element|null — куда вставлять виджет
     * - extractProductData(): { productName, category, weightKg, weightSource,
     *     fallbackWeightKg, packQuantity, volumeEstimatedWeightKg, dimensions,
     *     dimensionsSource, compositionText, pairsCount } — может быть обычным
     *   объектом (как у Ozon, синхронный DOM-скрапинг) ИЛИ Promise с таким же
     *   объектом (например если данные приходят через fetch к API маркетплейса).
     * - triggerCharacteristicsReveal?(): boolean — опционально, раскрыть скрытые характеристики
     */
    function createRunner(adapter) {
        let scheduledRun = null;
        /** Момент первого "непойманного" изменения DOM в текущей серии — для потолка ожидания. */
        let pendingBurstStartedAt = null;
        /** Идентичность карточки (без габаритов): габариты могут догрузиться позже. */
        let currentIdentityKey = "";
        /** Случайный эко-герой фиксируем на один товар (чтобы не мигал при каждом MutationObserver). */
        let currentHero = null;
        let observer = null;
        let isRendering = false;

        /**
         * Короткое ожидание: максимум ~0.6с.
         * Если не нашли вес — сразу используем fallback по категории.
         */
        async function waitForProductData(maxAttempts = 4, delayMs = 150) {
            for (let i = 0; i < maxAttempts; i += 1) {
                if (i === 1 || i === 2) adapter.triggerCharacteristicsReveal?.();
                const data = await adapter.extractProductData();
                if (data.weightKg) return data;
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return adapter.extractProductData();
        }

        async function runWidgetPipeline() {
            if (isRendering) return;
            isRendering = true;

            try {
                if (!adapter.isProductPage()) {
                    document.getElementById("eco-widget-container")?.remove();
                    currentIdentityKey = "";
                    currentHero = null;
                    return;
                }

                const target = adapter.findInjectionTarget();
                if (!target) return;

                logStep(1, "Страница товара найдена", {
                    url: location.pathname,
                    injectionTarget: target.tagName + (target.getAttribute("data-widget") ? `[data-widget=${target.getAttribute("data-widget")}]` : "")
                });

                let data = await adapter.extractProductData();
                if (!data.weightKg) {
                    adapter.triggerCharacteristicsReveal?.();
                    data = await waitForProductData();
                }

                logStep(2, "Данные со страницы собраны", {
                    productName: data.productName,
                    category: data.category,
                    pairsCount: data.pairsCount,
                    "ВЕС (реальный)": data.weightKg,
                    "└─ откуда взят вес": data.weightSource,
                    "вес fallback (запасной, по категории)": data.fallbackWeightKg,
                    "штук в упаковке": data.packQuantity,
                    "вес по объёму (Д×Ш×В × плотность)": data.volumeEstimatedWeightKg,
                    dimensions: data.dimensions,
                    "└─ откуда взяты размеры": data.dimensionsSource,
                    compositionTextSnippet: (data.compositionText || "").slice(0, 150) || "(пусто)"
                });

                const result = computeComprehensiveEmission(data);

                logStep(3, "Выбрана ветка расчета", {
                    branch: result.branch,
                    "метод оценки веса": result.weightEstimationMethod,
                    "найден материал?": result.isMaterialMatch,
                    "источник коэффициента": result.source,
                    usedWeightKg: result.usedWeight,
                    usedCoefficient: result.usedCoefficient
                });

                // Идентификация карточки, чтобы герой не "мигал" при каждом MutationObserver.
                const identityKey = `${location.pathname}|${data.productName}|${result.usedWeight}`;
                if (identityKey !== currentIdentityKey) {
                    currentIdentityKey = identityKey;
                    currentHero = pickHero();
                }

                const productEmission = result.emission;
                const packagingEmission = data.dimensions ? calcPackagingEmissionKg(data.dimensions) : 0;
                const totalFootprint = productEmission + packagingEmission;

                logStep(4, "Итоговые цифры посчитаны", {
                    productEmissionKg: Number(productEmission.toFixed(3)),
                    packagingEmissionKg: Number(packagingEmission.toFixed(3)),
                    totalFootprintKg: Number(totalFootprint.toFixed(3))
                });

                renderWidget(target, {
                    totalFootprint,
                    productEmission,
                    packagingEmission,
                    weightUsed: result.usedWeight,
                    isFallback: result.isFallbackWeight,
                    calcSource: result.source,
                    hero: currentHero || pickHero()
                });

                logStep(5, "Виджет отрисован", { hero: (currentHero || {}).name });
            } catch (err) {
                console.error("Eco-Extension Error:", err);
            } finally {
                isRendering = false;
            }
        }

        /**
         * Обычный дебаунс (ждём delay мс тишины) — но с потолком: на сайтах с
         * непрерывной фоновой возней в DOM (карусели, чат-виджеты, баннеры — как на
         * WB) мутации могут сбрасывать таймер практически бесконечно, и виджет так
         * и не появляется. Поэтому считаем время с НАЧАЛА текущей серии изменений и
         * не даём общей задержке превысить MAX_WAIT_MS, даже если тишины не было.
         */
        const MAX_WAIT_MS = 1500;

        function scheduleRun(delay = 250) {
            const now = Date.now();
            if (pendingBurstStartedAt === null) pendingBurstStartedAt = now;

            const elapsed = now - pendingBurstStartedAt;
            const effectiveDelay = Math.max(0, Math.min(delay, MAX_WAIT_MS - elapsed));

            window.clearTimeout(scheduledRun);
            scheduledRun = window.setTimeout(() => {
                pendingBurstStartedAt = null;
                runWidgetPipeline().catch(() => {});
            }, effectiveDelay);
        }

        function setupNavigationHooks() {
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;

            history.pushState = function (...args) {
                const result = originalPushState.apply(this, args);
                scheduleRun(150);
                return result;
            };

            history.replaceState = function (...args) {
                const result = originalReplaceState.apply(this, args);
                scheduleRun(150);
                return result;
            };

            window.addEventListener("popstate", () => scheduleRun(150));
        }

        function setupObserver() {
            if (observer) observer.disconnect();
            observer = new MutationObserver(() => scheduleRun(350));
            observer.observe(document.body, { childList: true, subtree: true });
        }

        return {
            start() {
                setupNavigationHooks();
                setupObserver();
                scheduleRun(0);
            }
        };
    }

    window.EcoCore = {
        logStep,
        parseNumber,
        normalizeWeightKg,
        parseWeightToKg,
        parseDimensionsMm,
        inferWeightFromTitle,
        detectCategoryBucket,
        inferFallbackWeightKg,
        extractPackQuantity,
        estimateWeightFromVolumeKg,
        extractDimensionsFromSeparateFields,
        getPairValue,
        extractWeightFromPairs,
        buildCompositionBlob,
        hasWholeWord,
        matchMaterialCoefficient,
        matchCategoryCoefficient,
        computeComprehensiveEmission,
        calcPackagingWeightKg,
        calcPackagingEmissionKg,
        createRunner
    };
})();
