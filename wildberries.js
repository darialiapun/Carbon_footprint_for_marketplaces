/**
 * Адаптер Wildberries: данные о товаре берём из card.json — статичного JSON,
 * который сама страница WB загружает с basket-NN.wbbasket.ru для своего рендера
 * (там уже готовые поля options/compositions/габариты — надёжнее, чем скрапинг DOM).
 *
 * Номер шарда basket-NN у WB периодически меняется, поэтому мы его НЕ угадываем —
 * вместо этого читаем реальный URL уже выполненного запроса через Resource Timing
 * API браузера (страница сама его сделала до/во время нашего content script).
 * Если по какой-то причине card.json не нашёлся — тихо остаёмся без данных, и
 * виджет посчитает всё по fallback-у категории (как на Ozon при неудаче извлечения).
 */
(function () {
    "use strict";

    const EcoCore = window.EcoCore;

    const SELECTORS = {
        // Кнопка "Купить"/блок цены — рядом с ним вставляем виджет.
        // WB использует хэшированные CSS-модули (например "actionsBlockMain--qmJlL") —
        // хэш-суффикс после "--" может смениться при деплое, поэтому матчим только
        // устойчивую смысловую часть класса через [class*="..."].
        rightColumn: [
            '[class*="actionsBlockMain"]',
            '[class*="productPrice"]',
            '[class*="priceBlock"]',
            'aside'
        ],
        title: "h1"
    };

    function normalizePairKey(label) {
        return label.trim().toLowerCase().replace(/\s+/g, " ");
    }

    function getNmIdFromUrl() {
        const m = location.pathname.match(/\/catalog\/(\d+)\//);
        return m ? m[1] : null;
    }

    /**
     * Ищем среди уже выполненных сетевых запросов страницы тот, что вернул
     * card.json — так мы получаем реальный, актуальный на сегодня basket-хост,
     * не пытаясь вычислить/угадать его сами.
     *
     * WB — SPA: при переходе между товарами без полной перезагрузки страницы
     * записи о СТАРЫХ card.json остаются в performance-логе браузера. Поэтому
     * матчим URL именно по артикулу текущего товара (он есть прямо в пути:
     * .../<nmId>/info/ru/card.json), а не берём первый попавшийся card.json —
     * иначе залипают данные предыдущего товара.
     */
    function findCardJsonUrlFromPerformance(nmId) {
        const entries = performance.getEntriesByType("resource");
        const re = new RegExp(`basket-\\d+\\.wbbasket\\.ru/.*/${nmId}/info/ru/card\\.json`, "i");
        const matches = entries.filter((e) => re.test(e.name));
        if (!matches.length) return null;
        // Берём самую свежую запись (на случай если этот же товар открывали раньше).
        return matches[matches.length - 1].name;
    }

    async function waitForCardJsonUrl(nmId, maxAttempts = 15, delayMs = 200) {
        for (let i = 0; i < maxAttempts; i += 1) {
            const url = findCardJsonUrlFromPerformance(nmId);
            if (url) return url;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return null;
    }

    async function fetchCardJson(nmId) {
        try {
            const url = await waitForCardJsonUrl(nmId);
            if (!url) return null;
            const res = await fetch(url, { credentials: "omit" });
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            return null;
        }
    }

    function cmToMm(text) {
        if (!text) return null;
        const n = EcoCore.parseNumber(String(text).replace(/[^\d.,]/g, ""));
        return n === null ? null : n * 10;
    }

    function buildPairsFromOptions(options) {
        const pairs = {};
        for (const opt of options || []) {
            if (!opt?.name || opt.value === undefined || opt.value === null) continue;
            pairs[normalizePairKey(opt.name)] = String(opt.value);
        }
        return pairs;
    }

    /**
     * У WB есть отдельно габариты УПАКОВКИ ("Ширина/Высота/Длина упаковки", в см)
     * и габариты самого ПРЕДМЕТА ("Высота/Глубина/Ширина предмета") — берём именно
     * упаковку, она ближе к тому, что реально едет в посылке (как объём коробки у Ozon).
     */
    function extractPackageDimensionsMm(pairs) {
        const widthMm = cmToMm(pairs["ширина упаковки"]);
        const heightMm = cmToMm(pairs["высота упаковки"]);
        const lengthMm = cmToMm(pairs["длина упаковки"]);
        if (![widthMm, heightMm, lengthMm].every((n) => Number.isFinite(n))) return null;
        return { lengthMm, widthMm, heightMm };
    }

    /** На WB вес обычно называется "Вес товара", "Вес с упаковкой" и т.п. */
    function extractWeightFromPairsWb(pairs) {
        for (const [key, value] of Object.entries(pairs)) {
            if (!/вес|масса/i.test(key)) continue;
            const parsed = EcoCore.parseWeightToKg(value) || EcoCore.parseWeightToKg(`${value} г`);
            if (parsed) return parsed;
        }
        return null;
    }

    function buildProductDataFromCardJson(card) {
        const pairs = buildPairsFromOptions(card.options);
        const productName = card.imt_name || "Товар";
        const category = [card.subj_root_name, card.subj_name].filter(Boolean).join(" / ") || productName;

        const weightKg = extractWeightFromPairsWb(pairs);
        const dimensions = extractPackageDimensionsMm(pairs);
        // compositions — уже чистый список материалов от WB, состав парсить не нужно.
        const compositionText = (card.compositions || [])
            .map((c) => c.name)
            .filter(Boolean)
            .join(", ");

        const categoryBucket = EcoCore.detectCategoryBucket(category, productName);
        // "Комплектация"/contents может содержать "рюкзак - 1 шт" и т.п.
        const packQuantity = EcoCore.extractPackQuantity(pairs, `${productName} ${card.contents || ""}`);
        const fallbackWeightKg = EcoCore.inferFallbackWeightKg(category, productName) * packQuantity;
        const volumeEstimatedWeightKg = EcoCore.estimateWeightFromVolumeKg(dimensions, categoryBucket);

        return {
            productName,
            category,
            weightKg,
            weightSource: weightKg ? "options card.json" : "не найден (пойдет fallback)",
            fallbackWeightKg,
            packQuantity,
            volumeEstimatedWeightKg,
            dimensions,
            dimensionsSource: dimensions ? "card.json (упаковка, см→мм)" : "не найдены",
            compositionText,
            pairsCount: Object.keys(pairs).length
        };
    }

    function emptyProductData(note) {
        // Даже если card.json не пришёл, не подставляем вес 0 — считаем честный
        // fallback по категории/названию (то же, что делает Ozon при неудаче).
        const productName = document.querySelector(SELECTORS.title)?.textContent?.trim() || "Товар";
        return {
            productName,
            category: "",
            weightKg: null,
            weightSource: note,
            fallbackWeightKg: EcoCore.inferFallbackWeightKg("", productName),
            packQuantity: 1,
            volumeEstimatedWeightKg: null,
            dimensions: null,
            dimensionsSource: note,
            compositionText: "",
            pairsCount: 0
        };
    }

    // Кэшируем card.json на артикул. Важно: пытаемся получить его ТОЛЬКО ОДИН РАЗ
    // на товар — extractProductData() может вызываться много раз подряд (ретраи
    // конвейера, срабатывания MutationObserver), и если при неудаче каждый раз
    // заново ждать до 3с поиска URL — задержки складываются в десятки секунд.
    // Поэтому все вызовы для одного и того же товара разделяют один и тот же
    // промис и получают его результат мгновенно после первой попытки.
    let cachedCardData = null;
    let cachedForNmId = null;
    let attemptedNmId = null;
    let inFlightPromise = null;

    async function extractProductData() {
        const nmId = getNmIdFromUrl();
        if (!nmId) return emptyProductData("страница не похожа на карточку товара");

        if (attemptedNmId !== nmId) {
            if (!inFlightPromise) {
                inFlightPromise = fetchCardJson(nmId).then((card) => {
                    attemptedNmId = nmId;
                    if (card && getNmIdFromUrl() === nmId) {
                        cachedForNmId = nmId;
                        cachedCardData = buildProductDataFromCardJson(card);
                    }
                    inFlightPromise = null;
                });
            }
            await inFlightPromise;
        }

        return cachedCardData && cachedForNmId === nmId
            ? cachedCardData
            : emptyProductData("card.json не найден (пойдет fallback по категории)");
    }

    function isProductPage() {
        return Boolean(getNmIdFromUrl());
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
        extractProductData
        // triggerCharacteristicsReveal не нужен — данные приходят из API, а не из DOM.
    }).start();
})();
