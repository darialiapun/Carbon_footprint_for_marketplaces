(function () {
    "use strict";


    const MONTH_LIMIT_CO2 = 166;
    const LDPE_DENSITY = 920;
    const LDPE_THICKNESS_M = 0.00006;
    const LDPE_EMISSION_FACTOR = 2.11;
    const FALLBACK_WEIGHTS = {
        clothing: 0.5,       
        outerwear: 1.5,     
        shoes: 1.0,          
        electronics: 1.2,   
        beauty: 0.25,        
        home_chem: 1.0,      
        furniture: 15.0,    
        food: 0.5,          
        default: 0.7
    };
    /* Коэффициенты материалов: кг CO2 на кг материала */
    const MATERIAL_COEFFICIENTS = {
        "натуральный шелк": 35,
        кашемир: 55,
        овчина: 45,
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
    

    const SELECTORS = {
        rightColumn: [
            '[data-widget="webPrice"]',
            '[data-widget="addToCartButton"]',
            '[data-widget="webStickyProducts"]',
            'aside',
            '.p8e'
        ],
        title: "h1",
        breadcrumbs: '[data-widget="breadCrumbs"] a, nav[aria-label*="хлеб"] a'
    };

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

    let scheduledRun = null;
    /** Идентичность карточки (без габаритов): габариты могут догрузиться позже. */
    let currentIdentityKey = "";
    /** Случайный эко-герой фиксируем на один товар (чтобы не мигал при каждом MutationObserver). */
    let currentHero = null;
    let observer = null;
    let isRendering = false;

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

    function extractWeightFromVariantButtons() {
        const containers = Array.from(document.querySelectorAll("section, div, ul, form"));
        const carrier = containers.find((el) => /вес\s*товара/i.test(el.textContent || ""));
        if (!carrier) return null;
        const carrierText = (carrier.textContent || "").toLowerCase();
        const carrierUnit =
            /\bкг\b|kg/.test(carrierText) ? "kg" :
            (/\bг\b/.test(carrierText) ? "g" : null);

        const options = Array.from(carrier.querySelectorAll("button, label, li, div[role='button'], a"));
        if (!options.length) return null;

        const readWeight = (text) => {
            if (!text) return null;
            const m = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|kg|g)\b/i);
            if (m) return parseWeightToKg(`${m[1]} ${m[2]}`);

            // На Ozon в кнопках часто только числа (например 400, 800, 1500),
            // а единица измерения дана в заголовке "Вес товара, г".
            const pure = text.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
            if (!pure || !carrierUnit) return null;
            return parseWeightToKg(`${pure[1]} ${carrierUnit}`);
        };

        const isSelected = (el) => {
            const ariaPressed = el.getAttribute("aria-pressed");
            const ariaSelected = el.getAttribute("aria-selected");
            const ariaCurrent = el.getAttribute("aria-current");
            const cls = (el.className || "").toString().toLowerCase();
            return ariaPressed === "true" || ariaSelected === "true" || ariaCurrent === "true" ||
                /\b(active|selected|current|checked)\b/.test(cls);
        };

        const selected = options.find((el) => isSelected(el));
        if (selected) {
            const selectedWeight = readWeight(selected.textContent || "");
            if (selectedWeight) return selectedWeight;
        }

        // Если текущий вариант не удалось определить — берём первое валидное значение.
        for (const el of options) {
            const w = readWeight(el.textContent || "");
            if (w) return w;
        }
        return null;
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
        if (/обувь|кроссов|ботинк|туфл|кеды|сланц|сапог/.test(hay)) return "shoes";
        if (/одежд|плать|футбол|поло|куртк|брюк|шорт|юбк|белье/.test(hay)) return "clothing";
        if (/космет|крем|сыворотк|шампун|гель|маск|парф|дезодорант/.test(hay)) return "beauty";
        if (/бытовая\s*химия|моющ|чистящ|таблетк.*посудомо/.test(hay)) return "home_chem";
        if (/бытовая\s*техника|фен|пылесос|чайник|блендер|мультивар|утюг|электрон|смартфон|телефон|ноутбук|планшет|наушник/.test(hay)) return "electronics";
        if (/мебель|диван|шкаф|кресл|стол|стул|матрас/.test(hay)) return "furniture";
        if (/продукты\s*питания|гастроном|супермаркет|кулинар|корм|консерв|колбас|сыр|хлеб|овощ|фрукт/.test(hay)) return "food";
        return "default";
    }

    function inferFallbackWeightKg(categoryText, productName) {
        const titleWeight = inferWeightFromTitle(productName);
        if (titleWeight && titleWeight > 0) return titleWeight;
        const bucket = detectCategoryBucket(categoryText, productName);
        return FALLBACK_WEIGHTS[bucket] || FALLBACK_WEIGHTS.default;
    }

    function deriveCategoryText(productName) {
        const crumbs = Array.from(document.querySelectorAll(SELECTORS.breadcrumbs))
            .map((el) => el.textContent?.trim())
            .filter(Boolean)
            .join(" / ");
        if (crumbs) return crumbs;

        const path = decodeURIComponent(location.pathname || "").replace(/[/-]+/g, " ");
        const pathMatch = path.match(/(?:category|catalog|product)\s+(.{2,120})/i);
        if (pathMatch?.[1]) return pathMatch[1];

        return productName || "Товар";
    }

    function triggerCharacteristicsReveal() {
        const candidates = Array.from(document.querySelectorAll("button, a, summary, div[role='button']"));
        const revealPatterns = [
            /все характеристики/i,
            /характеристики/i,
            /показать (еще|все|полностью)/i,
            /развернуть/i
        ];

        for (const el of candidates) {
            const txt = el.textContent?.trim();
            if (!txt) continue;
            if (!revealPatterns.some((re) => re.test(txt))) continue;
            if (!el.isConnected) continue;

            const hidden = el.getAttribute("aria-expanded");
            if (hidden === "false" || /показать|развернуть|все/i.test(txt)) {
                el.click();
                return true;
            }
        }
        return false;
    }

    function normalizePairKey(label) {
        return label.trim().toLowerCase().replace(/\s+/g, " ");
    }

    /**
     * Ozon часто меняет названия характеристик между категориями.
     * Поэтому здесь не точные строки, а «семантические» паттерны:
     * - вес: "Вес, г", "Вес товара", "Вес в упаковке", "Масса" и т.п.
     * - размеры: "Размеры", "Габариты", "Размеры упаковки" и т.п.
     */
    function labelLooksLikeSpecKey(text) {
        if (!text || text.length > 140) return false;
        const t = text.trim();
        if (/^(состав|материал(?:\s+(?:верха|подкладки|изделия|стельки|подошвы))?)$/i.test(t)) return true;
        if (/состав\s+материала/i.test(t)) return true;
        if (/(^|\s)(вес|масса)(\s|$)/i.test(t)) return true;
        if (/(^|\s)(размеры|габариты)(\s|$)/i.test(t)) return true;
        return false;
    }

    function collectPairsFromAboutSection() {
        const pairs = {};
        const headings = Array.from(document.querySelectorAll("h2, h3, div, span"));
        const aboutHeading = headings.find((el) => /^о товаре$/i.test((el.textContent || "").trim()));
        if (!aboutHeading) return pairs;

        const container =
            aboutHeading.closest("section") ||
            aboutHeading.parentElement?.closest("div") ||
            aboutHeading.parentElement;
        if (!container) return pairs;

        // Ищем строкоподобные элементы, где есть "ключ / значение".
        const rows = container.querySelectorAll("li, tr, div");
        for (const row of rows) {
            const children = Array.from(row.children).filter((ch) => (ch.textContent || "").trim().length > 0);
            if (children.length < 2 || children.length > 4) continue;

            const key = (children[0].textContent || "").trim();
            const value = (children[1].textContent || "").trim();
            if (!key || !value) continue;
            if (!labelLooksLikeSpecKey(key)) continue;

            pairs[normalizePairKey(key)] = value;
        }
        return pairs;
    }

    function collectLabelValuePairs() {
        const pairs = {};
        const aboutPairs = collectPairsFromAboutSection();
        Object.assign(pairs, aboutPairs);

        // Быстрые узкие корни вместо полного document.body.
        const roots = [
            document.querySelector('[data-widget*="webCharacteristics"]'),
            document.querySelector('[data-widget*="characteristics"]'),
            document.querySelector('[data-widget="webShortCharacteristics"]'),
            document.querySelector("main")
        ].filter(Boolean);

        const uniqueRoots = roots.length ? roots : [document.body];
        const seenKeys = new Set();

        for (const root of uniqueRoots) {
            // Сначала читаем структурные элементы; div/span/p только во вторую очередь.
            const nodes = root.querySelectorAll("dt, th, td, li, div, span, p");
            for (const node of nodes) {
                const text = node.textContent?.trim();
                if (!text || !labelLooksLikeSpecKey(text)) continue;

                const key = normalizePairKey(text);
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);

                let valueText = "";

                // Частый кейс: key в одной ячейке, value в соседней
                const next = node.nextElementSibling;
                if (next?.textContent) valueText = next.textContent.trim();

                // Иногда key/value лежат в одной строке: "Вес, г 250"
                if (!valueText) {
                    const inLine = text.match(/^(.*?)(\d[\d\s.,]*)(\s*(кг|г|мм))?$/i);
                    if (inLine && inLine[2]) valueText = `${inLine[2]} ${inLine[4] || ""}`.trim();
                }

                // Фоллбэк: берём текст родителя без ключа
                if (!valueText) {
                    const parentText = node.parentElement?.textContent?.trim() || "";
                    const stripped = parentText.replace(text, "").trim();
                    if (stripped && stripped.length <= 250) valueText = stripped;
                }

                if (valueText) pairs[key] = valueText;
            }
        }
        return pairs;
    }

    function extractFromScriptJson() {
        const result = { weightKg: null, dimensions: null };
        const scripts = document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script');

        for (const script of scripts) {
            const txt = script.textContent;
            if (!txt || txt.length < 20) continue;
            if (!/(weight|вес|размер|габарит|dimension|shippingWeight)/i.test(txt)) continue;

            // Часто в json встречаются "weight":"250 г" / "shippingWeight":"0.4 kg"
            if (!result.weightKg) {
                const wMatch = txt.match(/"(?:weight|shippingWeight|grossWeight|itemWeight|вес[^"]*)"\s*:\s*"?(.*?)"?(?:,|\})/i);
                if (wMatch?.[1]) {
                    const parsed = parseWeightToKg(wMatch[1]);
                    if (parsed) result.weightKg = parsed;
                }
            }

            // Фоллбэк по произвольному тексту скрипта
            if (!result.weightKg) {
                const wTxt = txt.match(/(?:weight|shippingWeight|вес)[^0-9]{0,30}(\d+(?:[.,]\d+)?\s*(?:кг|г|kg|g|л|l|мл|ml))/i)?.[1];
                if (wTxt) result.weightKg = parseWeightToKg(wTxt);
            }

            if (!result.dimensions) {
                const dTxt =
                    txt.match(/(?:dimensions|габарит|размер[^"]*)[^0-9]{0,40}(\d+(?:[.,]\d+)?\D{0,6}\d+(?:[.,]\d+)?\D{0,6}\d+(?:[.,]\d+)?)/i)?.[1] ||
                    txt.match(/(\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*(?:мм|mm))/i)?.[1];
                if (dTxt) result.dimensions = parseDimensionsMm(dTxt);
            }

            if (result.weightKg && result.dimensions) break;
        }

        return result;
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

    function extractProductData() {
        const pairs = collectLabelValuePairs();
        const fullText = document.body.innerText || "";
        const fromScripts = extractFromScriptJson();

        // Вес: пытаемся взять из pairs по любому ключу с "вес/масса",
        // иначе ищем в тексте страницы (разные формулировки).
        const weightFromPairsText =
            getPairValue(pairs, /\bвес\b|\bмасса\b/i) ||
            fullText.match(/(?:Вес|Масса)(?:\s+товара)?(?:\s+в\s+упаковке)?[^\d]{0,30}(\d[\d\s.,]*\s*(?:кг|г|kg|g|мл|ml|л|l))/i)?.[1];

        // Размеры/габариты: аналогично, ищем по "размер/габарит".
        const dimensionsFromPairs =
            getPairValue(pairs, /\bразмер|\bгабарит/i) ||
            fullText.match(/(?:Размеры|Габариты)(?:\s+упаковки)?[^\d]{0,30}([^\n]{1,80})/i)?.[1];

        const weightFromVariants = extractWeightFromVariantButtons();
        const weightFromPairKeys = extractWeightFromPairs(pairs);
        const weightFromPageText = parseWeightToKg(weightFromPairsText);

        // Отслеживаем, какой именно способ дал вес — это и есть то,
        // что раньше было не видно и мешало понять, откуда берутся "похожие" цифры.
        let weightKg = null;
        let weightSource = "не найден (пойдет fallback)";
        if (weightFromPairKeys) {
            weightKg = weightFromPairKeys;
            weightSource = "пары «характеристика: значение»";
        } else if (weightFromPageText) {
            weightKg = weightFromPageText;
            weightSource = "текст страницы (regex по слову «Вес/Масса»)";
        } else if (weightFromVariants) {
            weightKg = weightFromVariants;
            weightSource = "кнопки вариантов (выбор веса)";
        } else if (fromScripts.weightKg) {
            weightKg = fromScripts.weightKg;
            weightSource = "JSON внутри <script>";
        }

        const dimensionsFromPairsParsed = parseDimensionsMm(dimensionsFromPairs);
        let dimensions = null;
        let dimensionsSource = "не найдены";
        if (dimensionsFromPairsParsed) {
            dimensions = dimensionsFromPairsParsed;
            dimensionsSource = "пары «характеристика: значение»";
        } else if (fromScripts.dimensions) {
            dimensions = fromScripts.dimensions;
            dimensionsSource = "JSON внутри <script>";
        }

        const compositionText = buildCompositionBlob(pairs, fullText);

        const productName = document.querySelector(SELECTORS.title)?.textContent?.trim() || "Товар";
        const category = deriveCategoryText(productName);
        const fallbackWeightKg = inferFallbackWeightKg(category, productName);

        return {
            productName,
            category,
            weightKg,
            weightSource,
            fallbackWeightKg,
            dimensions,
            dimensionsSource,
            compositionText,
            pairsCount: Object.keys(pairs).length
        };
    }

    /**
     * Короткое ожидание: максимум ~0.6с.
     * Если не нашли вес — сразу используем fallback по категории.
     */
    async function waitForProductData(maxAttempts = 4, delayMs = 150) {
        for (let i = 0; i < maxAttempts; i += 1) {
            if (i === 1 || i === 2) triggerCharacteristicsReveal();
            const data = extractProductData();
            if (data.weightKg) return data;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return extractProductData();
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
        const fallbackWeight = data.fallbackWeightKg || null;
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
                branch: "2_2_real_weight_category"
            };
        }

        // 3) примерный вес * категория
        const finalWeight = fallbackWeight || realWeight || 0;
        if (!finalWeight) {
            return {
                emission: 0,
                usedWeight: 0,
                usedCoefficient: 0,
                source: "none",
                isFallbackWeight: true,
                isMaterialMatch: false,
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
            branch: "3_fallback_weight_category"
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
        // Добавляем путь к папке animals перед именем файла
        return chrome.runtime.getURL(`animals/${fileName}`);
    }
    function getCurrentMonthLabel() {
        const month = new Date().toLocaleString("ru-RU", { month: "long" });
        return month.toUpperCase();
    }

    function findInjectionTarget() {
        for (const selector of SELECTORS.rightColumn) {
            const target = document.querySelector(selector);
            if (target) return target;
        }
        return null;
    }

    function upsertWidget(target) {
        let widget = document.getElementById("eco-widget");
        if (!widget) {
            widget = document.createElement("section");
            widget.id = "eco-widget";
            widget.className = "eco-widget-card";
            target.insertAdjacentElement("afterend", widget);
        } else if (!widget.isConnected && target.parentElement) {
            target.insertAdjacentElement("afterend", widget);
        }
        return widget;
    }

        function renderWidget(target, payload) {
            const widget = upsertWidget(target);
            
            // 1. Присваиваем ID всему виджету (для максимального приоритета CSS)
            widget.id = "eco-widget-container";
            
            // Данные для расчетов
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
        
            // 2. Вставляем HTML с объединенным текстовым блоком
            widget.innerHTML = `
                <style>
                    /* Стили, которые Ozon точно не перебьет (обращение через ID) */
                    
                    #eco-widget-container .eco-widget-card { 
                        padding: 16px 16px 12px 16px; 
                        border: 1px solid #e0e0e0; 
                        border-radius: 16px; 
                        background: white; 
                        font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; 
                        box-shadow: 0 4px 12px rgba(0,0,0,0.05);
                    }
                    
                    /* Крупный заголовок */
                    #eco-widget-container .eco-header { 
                        font-weight: bold; 
                        font-size: 22px !important; 
                        color: #2c3e50 !important; 
                        margin-bottom: 16px; 
                    }
                    
                    /* Верхняя часть с цифрами */
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
                    
                    /* Блок героя */
                    #eco-widget-container .eco-hero-box { 
                        display: flex; 
                        align-items: flex-start; 
                        margin-top: 12px;
                        position: relative;
                        min-height: 55px;
                    }
        
                    /* --- ГЛАВНОЕ: ТЕКСТ ПРО ЖИВОТНОЕ (ОБЕ СТРОКИ 13PX И СЕРЫЕ) --- */
                    
                    #eco-widget-container .eco-hero-text-block { 
                        flex: 1;
                        font-size: 13px !important; 
                        color: #5d6d7e !important; /* Серый цвет */
                        line-height: 1.4 !important;
                        font-weight: 600 !important;
                        padding-right: 50px; /* Место для зверя */
                        z-index: 1;
                    }
        
                    /* --- ГЛАВНОЕ: КАРТИНКА-НАКЛЕЙКА --- */
                    
                    #eco-widget-container .eco-hero-image { 
                        position: absolute;
                        right: ${heroImageRight}; 
                        top: ${heroImageTop};    
                        width: ${heroImageSize}; 
                        height: ${heroImageSize}; 
                        object-fit: contain;
                        
                        /* МАГИЯ НАКЛЕЙКИ: Убирает белый фон! */
                        mix-blend-mode: multiply; 
                        
                        /* БЕЛАЯ ОБВОДКА СТИКЕРА (необязательно, но красиво) */
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
    async function runWidgetPipeline() {
        if (isRendering) return;
        isRendering = true;

        try {
            //  Проверка страницы (Твоя логика)
            const isProductPage =
                /\/product\//.test(location.pathname) || /\/context\/detail\/id\//.test(location.pathname);

            if (!isProductPage) {
                document.getElementById("eco-widget")?.remove();
                currentIdentityKey = "";
                currentHero = null;
                return;
            }

            const target = findInjectionTarget();
            if (!target) return;

            logStep(1, "Страница товара найдена", {
                url: location.pathname,
                injectionTarget: target.tagName + (target.getAttribute("data-widget") ? `[data-widget=${target.getAttribute("data-widget")}]` : "")
            });

            //  Сбор данных (Твоя логика с ожиданием характеристик)
            let data = extractProductData();
            if (!data.weightKg) {
                triggerCharacteristicsReveal();
                data = await waitForProductData();
            }

            logStep(2, "Данные со страницы собраны", {
                productName: data.productName,
                category: data.category,
                pairsCount: data.pairsCount,
                "ВЕС (реальный)": data.weightKg,
                "└─ откуда взят вес": data.weightSource,
                "вес fallback (запасной)": data.fallbackWeightKg,
                dimensions: data.dimensions,
                "└─ откуда взяты размеры": data.dimensionsSource,
                compositionTextSnippet: (data.compositionText || "").slice(0, 150) || "(пусто)"
            });

            //  РАСЧЕТ ПО ВОРОНКЕ (Новое: Материал -> Категория -> Fallback)
            const result = computeComprehensiveEmission(data);

            logStep(3, "Выбрана ветка расчета", {
                branch: result.branch,
                "использован реальный вес?": !result.isFallbackWeight,
                "найден материал?": result.isMaterialMatch,
                "источник коэффициента": result.source,
                usedWeightKg: result.usedWeight,
                usedCoefficient: result.usedCoefficient
            });

            //  ИДЕНТИФИКАЦИЯ КАРТОЧКИ (Твоя логика, чтобы герой не "мигал")
            // Используем финальный вес для ключа
            const identityKey = `${location.pathname}|${data.productName}|${result.usedWeight}`;
            if (identityKey !== currentIdentityKey) {
                currentIdentityKey = identityKey;
                currentHero = pickHero();
            }

            //  ИТОГОВЫЕ ЦИФРЫ
            const productEmission = result.emission;
            const packagingEmission = data.dimensions ? calcPackagingEmissionKg(data.dimensions) : 0;
            // Убираем логистическую надбавку, чтобы расчет совпадал с формулой пользователя.
            const totalFootprint = productEmission + packagingEmission;

            logStep(4, "Итоговые цифры посчитаны", {
                productEmissionKg: Number(productEmission.toFixed(3)),
                packagingEmissionKg: Number(packagingEmission.toFixed(3)),
                totalFootprintKg: Number(totalFootprint.toFixed(3))
            });

            //  РЕНДЕР (Передаем всё в виджет)
            renderWidget(target, {
                totalFootprint,
                productEmission,
                packagingEmission,
                weightUsed: result.usedWeight, // полезно для отладки
                isFallback: result.isFallbackWeight, // пометка, если вес не настоящий
                calcSource: result.source, // какой материал или категория сработали
                hero: currentHero || pickHero()
            });

            logStep(5, "Виджет отрисован", { hero: (currentHero || {}).name });

        } catch (err) {
            console.error("Eco-Extension Error:", err);
        } finally {
            isRendering = false;
        }
    }
    
    function scheduleRun(delay = 250) {
        window.clearTimeout(scheduledRun);
        scheduledRun = window.setTimeout(() => {
            runWidgetPipeline().catch(() => {});
        }, delay);
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
    function upsertWidget(target) {
        // Проверяем по ID, чтобы не плодить дубликаты
        let existing = document.getElementById('eco-widget-container');
        if (existing) return existing; 
    
        const container = document.createElement('div');
        container.id = 'eco-widget-container';
        
        // Используем append, чтобы виджет встал ВНИЗУ блока (под ценой)
        target.append(container); 
        return container;
    }
    function setupObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => scheduleRun(350));
        observer.observe(document.body, { childList: true, subtree: true });
    }

    setupNavigationHooks();
    setupObserver();
    scheduleRun(0);
})();