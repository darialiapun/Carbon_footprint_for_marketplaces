/**
 * Адаптер Ozon: всё, что зависит от разметки конкретно ozon.ru — селекторы,
 * сбор характеристик из DOM, точка вставки виджета. Вся расчётная логика
 * и рендер виджета — в core.js (window.EcoCore).
 */
(function () {
    "use strict";

    const EcoCore = window.EcoCore;

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

    function parseNumber(raw) {
        return EcoCore.parseNumber(raw);
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
            if (m) return EcoCore.parseWeightToKg(`${m[1]} ${m[2]}`);

            // На Ozon в кнопках часто только числа (например 400, 800, 1500),
            // а единица измерения дана в заголовке "Вес товара, г".
            const pure = text.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
            if (!pure || !carrierUnit) return null;
            return EcoCore.parseWeightToKg(`${pure[1]} ${carrierUnit}`);
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
        if (/^(длина|ширина|высота|глубина)(\s|,|$)/i.test(t)) return true;
        return false;
    }

    /**
     * Основной блок характеристик Ozon: <div id="section-characteristics"> с рядами
     * <dl><dt>Ключ</dt><dd>Значение</dd></dl>. Собираем ВСЕ пары без фильтра по словам —
     * именно тут раньше терялось почти всё (например отдельные "Длина, мм"/"Ширина, мм",
     * которые не совпадают со словами "вес"/"размеры"). CSS-классы Ozon (типа "pdp_ia9")
     * хэшированные и часто меняются при деплоях — поэтому опираемся только на id и теги.
     */
    function collectPairsFromCharacteristicsSection() {
        const pairs = {};
        const container = document.querySelector("#section-characteristics");
        if (!container) return pairs;

        const rows = container.querySelectorAll("dl");
        for (const row of rows) {
            const key = row.querySelector("dt")?.textContent?.trim();
            const value = row.querySelector("dd")?.textContent?.trim();
            if (!key || !value) continue;
            pairs[normalizePairKey(key)] = value;
        }
        return pairs;
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

        // Самый надежный источник — секция "Характеристики" (dl/dt/dd), без фильтра
        // по словам. Добавляем последним, чтобы перекрыть менее точные совпадения выше.
        Object.assign(pairs, collectPairsFromCharacteristicsSection());

        return pairs;
    }

    function extractFromScriptJson() {
        const result = { weightKg: null, dimensions: null };
        const scripts = document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script');

        for (const script of scripts) {
            const txt = script.textContent;
            if (!txt || txt.length < 20) continue;
            if (!/(weight|вес|размер|габарит|dimension|shippingWeight)/i.test(txt)) continue;

            if (!result.weightKg) {
                const wMatch = txt.match(/"(?:weight|shippingWeight|grossWeight|itemWeight|вес[^"]*)"\s*:\s*"?(.*?)"?(?:,|\})/i);
                if (wMatch?.[1]) {
                    const parsed = EcoCore.parseWeightToKg(wMatch[1]);
                    if (parsed) result.weightKg = parsed;
                }
            }

            if (!result.weightKg) {
                const wTxt = txt.match(/(?:weight|shippingWeight|вес)[^0-9]{0,30}(\d+(?:[.,]\d+)?\s*(?:кг|г|kg|g|л|l|мл|ml))/i)?.[1];
                if (wTxt) result.weightKg = EcoCore.parseWeightToKg(wTxt);
            }

            if (!result.dimensions) {
                const dTxt =
                    txt.match(/(?:dimensions|габарит|размер[^"]*)[^0-9]{0,40}(\d+(?:[.,]\d+)?\D{0,6}\d+(?:[.,]\d+)?\D{0,6}\d+(?:[.,]\d+)?)/i)?.[1] ||
                    txt.match(/(\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*(?:мм|mm))/i)?.[1];
                if (dTxt) result.dimensions = EcoCore.parseDimensionsMm(dTxt);
            }

            if (result.weightKg && result.dimensions) break;
        }

        return result;
    }

    function extractProductData() {
        const pairs = collectLabelValuePairs();
        const fullText = document.body.innerText || "";
        const fromScripts = extractFromScriptJson();

        // Вес: пытаемся взять из pairs по любому ключу с "вес/масса",
        // иначе ищем в тексте страницы (разные формулировки).
        const weightFromPairsText =
            EcoCore.getPairValue(pairs, /\bвес\b|\bмасса\b/i) ||
            fullText.match(/(?:Вес|Масса)(?:\s+товара)?(?:\s+в\s+упаковке)?[^\d]{0,30}(\d[\d\s.,]*\s*(?:кг|г|kg|g|мл|ml|л|l))/i)?.[1];

        // Размеры/габариты: аналогично, ищем по "размер/габарит".
        const dimensionsFromPairs =
            EcoCore.getPairValue(pairs, /\bразмер|\bгабарит/i) ||
            fullText.match(/(?:Размеры|Габариты)(?:\s+упаковки)?[^\d]{0,30}([^\n]{1,80})/i)?.[1];

        const weightFromVariants = extractWeightFromVariantButtons();
        const weightFromPairKeys = EcoCore.extractWeightFromPairs(pairs);
        const weightFromPageText = EcoCore.parseWeightToKg(weightFromPairsText);

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

        const dimensionsFromPairsParsed = EcoCore.parseDimensionsMm(dimensionsFromPairs);
        const dimensionsFromSeparateFields = EcoCore.extractDimensionsFromSeparateFields(pairs);
        let dimensions = null;
        let dimensionsSource = "не найдены";
        if (dimensionsFromPairsParsed) {
            dimensions = dimensionsFromPairsParsed;
            dimensionsSource = "пары «характеристика: значение»";
        } else if (dimensionsFromSeparateFields) {
            dimensions = dimensionsFromSeparateFields;
            dimensionsSource = "раздельные поля «Длина/Ширина/Высота»";
        } else if (fromScripts.dimensions) {
            dimensions = fromScripts.dimensions;
            dimensionsSource = "JSON внутри <script>";
        }

        const compositionText = EcoCore.buildCompositionBlob(pairs, fullText);

        const productName = document.querySelector(SELECTORS.title)?.textContent?.trim() || "Товар";
        const category = deriveCategoryText(productName);
        const categoryBucket = EcoCore.detectCategoryBucket(category, productName);
        const packQuantity = EcoCore.extractPackQuantity(pairs, productName);
        // Плоский fallback — это вес ОДНОЙ штуки, поэтому для комплектов умножаем на кол-во.
        const fallbackWeightKg = EcoCore.inferFallbackWeightKg(category, productName) * packQuantity;
        // Оценка по объёму точнее плоского fallback-веса, но доступна только если есть размеры.
        const volumeEstimatedWeightKg = EcoCore.estimateWeightFromVolumeKg(dimensions, categoryBucket);

        return {
            productName,
            category,
            weightKg,
            weightSource,
            fallbackWeightKg,
            packQuantity,
            volumeEstimatedWeightKg,
            dimensions,
            dimensionsSource,
            compositionText,
            pairsCount: Object.keys(pairs).length
        };
    }

    function isProductPage() {
        return /\/product\//.test(location.pathname) || /\/context\/detail\/id\//.test(location.pathname);
    }

    function findInjectionTarget() {
        for (const selector of SELECTORS.rightColumn) {
            const target = document.querySelector(selector);
            if (target) return target;
        }
        return null;
    }

    EcoCore.createRunner({
        isProductPage,
        findInjectionTarget,
        extractProductData,
        triggerCharacteristicsReveal
    }).start();
})();
