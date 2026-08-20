/**
 * Адаптер Wildberries.
 *
 * Основной источник данных — уже отрендеренная на странице таблица характеристик
 * (как на Ozon): быстро, синхронно, без сети. WB рендерит характеристики как
 * несколько <table> с <caption> ("Габариты", "Основная информация" и т.д.), внутри
 * строки <tr><th class="cellKey--HASH">Подпись</th><td class="cellValue--HASH">Значение</td></tr>.
 * Полный набор полей (включая вес) появляется только после клика по кнопке
 * "Характеристики и описание" — это раскрывает triggerCharacteristicsReveal().
 *
 * Подстраховка (если DOM почему-то пуст) — card.json, статичный JSON, который сама
 * страница WB загружает с basket-NN.wbbasket.ru для своего рендера. Номер шарда
 * basket-NN у WB периодически меняется, поэтому мы его не угадываем — читаем
 * реальный URL уже выполненного запроса через Resource Timing API браузера.
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

    function cmToMm(text) {
        if (!text) return null;
        const n = EcoCore.parseNumber(String(text).replace(/[^\d.,]/g, ""));
        return n === null ? null : n * 10;
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

    /** На WB вес обычно называется "Вес с упаковкой (кг)", "Вес без упаковки (кг)" и т.п. */
    function extractWeightFromPairsWb(pairs) {
        for (const [key, value] of Object.entries(pairs)) {
            if (!/вес|масса/i.test(key)) continue;
            const parsed = EcoCore.parseWeightToKg(value) || EcoCore.parseWeightToKg(`${value} г`);
            if (parsed) return parsed;
        }
        return null;
    }

    /**
     * Общая сборка итогового объекта данных из пар "характеристика: значение" —
     * используется и для DOM-пути, и для API-пути, чтобы не дублировать логику
     * веса/габаритов/fallback-а.
     */
    function assembleProductData(pairs, productName, category, opts = {}) {
        const weightKg = extractWeightFromPairsWb(pairs);
        const dimensions = extractPackageDimensionsMm(pairs);
        const compositionText =
            opts.compositionText !== undefined
                ? opts.compositionText
                : Object.entries(pairs)
                      .filter(([key]) => /состав|материал/.test(key))
                      .map(([, value]) => value)
                      .join(", ");

        const categoryBucket = EcoCore.detectCategoryBucket(category, productName);
        const packQuantity = EcoCore.extractPackQuantity(pairs, opts.packQuantityHintText || productName);
        const fallbackWeightKg = EcoCore.inferFallbackWeightKg(category, productName) * packQuantity;
        const volumeEstimatedWeightKg = EcoCore.estimateWeightFromVolumeKg(dimensions, categoryBucket);

        return {
            productName,
            category,
            weightKg,
            weightSource: weightKg ? (opts.weightSourceLabel || "характеристики") : "не найден (пойдет fallback)",
            fallbackWeightKg,
            packQuantity,
            volumeEstimatedWeightKg,
            dimensions,
            dimensionsSource: dimensions ? (opts.dimensionsSourceLabel || "характеристики") : "не найдены",
            compositionText,
            pairsCount: Object.keys(pairs).length
        };
    }

    function emptyProductData(productName, note) {
        return assembleProductData({}, productName, "", {
            weightSourceLabel: note,
            dimensionsSourceLabel: note
        });
    }

    // === Источник 1 (основной): DOM — уже отрендеренные таблицы характеристик ===

    /**
     * Собирает пары "характеристика: значение" из ВСЕХ таблиц характеристик на
     * странице (WB рендерит их несколькими <table> с разными <caption> —
     * "Габариты", "Основная информация" и т.п., но нам не важно деление на группы).
     * До клика по "Характеристики и описание" видна только часть полей — это
     * нормально, вызывающий код при необходимости повторит попытку после раскрытия.
     */
    function collectPairsFromCharacteristicsTables() {
        const pairs = {};
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
            const keyEl = row.querySelector('[class*="cellKey"]');
            const valueEl = row.querySelector('[class*="cellValue"]');
            if (!keyEl || !valueEl) continue;
            const key = keyEl.textContent?.trim();
            const value = valueEl.textContent?.trim();
            if (!key || !value) continue;
            pairs[normalizePairKey(key)] = value;
        }
        return pairs;
    }

    // Кнопка "Характеристики и описание" открывает НЕ инлайн-блок, а полноэкранное
    // модальное окно. Кликаем по ней максимум один раз на товар (иначе при каждом
    // повторном запуске пайплайна, пока вес ещё не найден, модалка выскакивала бы
    // заново) и сразу планируем её закрытие — пользователю не нужно видеть, как
    // расширение само открывает и держит открытым системное окно характеристик.
    let revealAttemptedForNmId = null;

    function closeCharacteristicsModal() {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
        );

        const closeBtn = Array.from(
            document.querySelectorAll('button[aria-label], [class*="closeBtn"], [class*="CloseButton"]')
        ).find(
            (el) => el.isConnected && el.offsetParent !== null && /закрыть/i.test(el.getAttribute("aria-label") || "")
        );
        if (closeBtn) closeBtn.click();
    }

    function triggerCharacteristicsReveal() {
        const nmId = getNmIdFromUrl();
        if (!nmId || revealAttemptedForNmId === nmId) return false;

        const candidates = Array.from(document.querySelectorAll("button, div[role='button'], a"));
        const el = candidates.find((el) => /характеристики\s+и\s+описание/i.test((el.textContent || "").trim()));
        if (!el || !el.isConnected) return false;

        revealAttemptedForNmId = nmId;
        el.click();
        setTimeout(closeCharacteristicsModal, 600);
        return true;
    }

    // === Источник 2 (подстраховка): card.json ===

    /**
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
        return matches[matches.length - 1].name;
    }

    async function waitForCardJsonUrl(nmId, maxAttempts = 40, delayMs = 100) {
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

    function buildPairsFromOptions(options) {
        const pairs = {};
        for (const opt of options || []) {
            if (!opt?.name || opt.value === undefined || opt.value === null) continue;
            pairs[normalizePairKey(opt.name)] = String(opt.value);
        }
        return pairs;
    }

    function buildProductDataFromCardJson(card) {
        const pairs = buildPairsFromOptions(card.options);
        const productName = card.imt_name || "Товар";
        const category = [card.subj_root_name, card.subj_name].filter(Boolean).join(" / ") || productName;
        // compositions — уже чистый список материалов от WB, состав парсить не нужно.
        const compositionText = (card.compositions || []).map((c) => c.name).filter(Boolean).join(", ");

        return assembleProductData(pairs, productName, category, {
            weightSourceLabel: "options card.json",
            dimensionsSourceLabel: "card.json (упаковка, см→мм)",
            compositionText,
            packQuantityHintText: `${productName} ${card.contents || ""}`
        });
    }

    // Пытаемся получить card.json ТОЛЬКО ОДИН РАЗ на товар — если при неудаче
    // каждый повторный вызов заново ждать несколько секунд, задержки складываются.
    let cachedCardData = null;
    let cachedForNmId = null;
    let attemptedNmId = null;
    let inFlightPromise = null;

    async function extractProductDataFromApi(nmId, productName) {
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
            : emptyProductData(productName, "ни DOM, ни card.json не дали данных (пойдет fallback по категории)");
    }

    // === Точка входа ===

    function extractProductData() {
        const nmId = getNmIdFromUrl();
        const productName = document.querySelector(SELECTORS.title)?.textContent?.trim() || "Товар";

        const domPairs = collectPairsFromCharacteristicsTables();
        if (Object.keys(domPairs).length > 0) {
            return assembleProductData(domPairs, productName, "", {
                weightSourceLabel: "таблица характеристик (DOM)",
                dimensionsSourceLabel: "таблица характеристик (DOM, см→мм)"
            });
        }

        // DOM пуст (например скрипт запустился до отрисовки таблиц) — подстраховываемся
        // через API карточки. Возвращаем Promise — core.js умеет его дожидаться.
        if (!nmId) return emptyProductData(productName, "страница не похожа на карточку товара");
        return extractProductDataFromApi(nmId, productName);
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
        extractProductData,
        triggerCharacteristicsReveal
    }).start();
})();
