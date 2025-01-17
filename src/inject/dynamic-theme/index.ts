import {replaceCSSVariables, getElementCSSVariables} from './css-rules';
import {overrideInlineStyle, getInlineOverrideStyle, watchForInlineStyles, stopWatchingForInlineStyles, INLINE_STYLE_SELECTOR} from './inline-style';
import {changeMetaThemeColorWhenAvailable, restoreMetaThemeColor} from './meta-theme-color';
import {getModifiedUserAgentStyle, getModifiedFallbackStyle, cleanModificationCache, parseColorWithCache, getSelectionColor} from './modify-css';
import type {StyleElement, StyleManager} from './style-manager';
import {manageStyle, getManageableStyles} from './style-manager';
import {watchForStyleChanges, stopWatchingForStyleChanges} from './watch';
import {forEach, push, toArray} from '../../utils/array';
import {removeNode, watchForNodePosition, iterateShadowHosts, isDOMReady, addDOMReadyListener, removeDOMReadyListener} from '../utils/dom';
import {logWarn} from '../utils/log';
import {throttle} from '../utils/throttle';
import {clamp} from '../../utils/math';
import {getCSSFilterValue} from '../../generators/css-filter';
import {modifyBackgroundColor, modifyColor, modifyForegroundColor} from '../../generators/modify-colors';
import {createTextStyle} from '../../generators/text-style';
import type {FilterConfig, DynamicThemeFix} from '../../definitions';
import {generateUID} from '../../utils/uid';
import type {AdoptedStyleSheetManager} from './adopted-style-manger';
import {createAdoptedStyleSheetOverride} from './adopted-style-manger';
import {isFirefox} from '../../utils/platform';
import {injectProxy} from './stylesheet-proxy';
import {parse} from '../../utils/color';
import {parsedURLCache} from '../../utils/url';

const variables = new Map<string, string>();
const INSTANCE_ID = generateUID();
const styleManagers = new Map<StyleElement, StyleManager>();
const adoptedStyleManagers = [] as AdoptedStyleSheetManager[];
let filter: FilterConfig = null;
let fixes: DynamicThemeFix = null;
let isIFrame: boolean = null;

function createOrUpdateStyle(className: string, root: ParentNode = document.head || document) {
    let element: HTMLStyleElement = root.querySelector(`.${className}`);
    if (!element) {
        element = document.createElement('style');
        element.classList.add('darkreader');
        element.classList.add(className);
        element.media = 'screen';
    }
    return element;
}

function createOrUpdateScript(className: string, root: ParentNode = document.head || document) {
    let element: HTMLScriptElement = root.querySelector(`.${className}`);
    if (!element) {
        element = document.createElement('script');
        element.classList.add('darkreader');
        element.classList.add(className);
    }
    return element;
}


const nodePositionWatchers = new Map<string, ReturnType<typeof watchForNodePosition>>();

function setupNodePositionWatcher(node: Node, alias: string) {
    nodePositionWatchers.has(alias) && nodePositionWatchers.get(alias).stop();
    nodePositionWatchers.set(alias, watchForNodePosition(node, 'parent'));
}

function stopStylePositionWatchers() {
    forEach(nodePositionWatchers.values(), (watcher) => watcher.stop());
    nodePositionWatchers.clear();
}

function createStaticStyleOverrides() {
    const fallbackStyle = createOrUpdateStyle('darkreader--fallback', document);
    fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: true});
    document.head.insertBefore(fallbackStyle, document.head.firstChild);
    setupNodePositionWatcher(fallbackStyle, 'fallback');

    const userAgentStyle = createOrUpdateStyle('darkreader--user-agent');
    userAgentStyle.textContent = getModifiedUserAgentStyle(filter, isIFrame, filter.styleSystemControls);
    document.head.insertBefore(userAgentStyle, fallbackStyle.nextSibling);
    setupNodePositionWatcher(userAgentStyle, 'user-agent');

    const textStyle = createOrUpdateStyle('darkreader--text');
    if (filter.useFont || filter.textStroke > 0) {
        textStyle.textContent = createTextStyle(filter);
    } else {
        textStyle.textContent = '';
    }
    document.head.insertBefore(textStyle, fallbackStyle.nextSibling);
    setupNodePositionWatcher(textStyle, 'text');

    const invertStyle = createOrUpdateStyle('darkreader--invert');
    if (fixes && Array.isArray(fixes.invert) && fixes.invert.length > 0) {
        invertStyle.textContent = [
            `${fixes.invert.join(', ')} {`,
            `    filter: ${getCSSFilterValue({
                ...filter,
                contrast: filter.mode === 0 ? filter.contrast : clamp(filter.contrast - 10, 0, 100),
            })} !important;`,
            '}',
        ].join('\n');
    } else {
        invertStyle.textContent = '';
    }
    document.head.insertBefore(invertStyle, textStyle.nextSibling);
    setupNodePositionWatcher(invertStyle, 'invert');

    const inlineStyle = createOrUpdateStyle('darkreader--inline');
    inlineStyle.textContent = getInlineOverrideStyle();
    document.head.insertBefore(inlineStyle, invertStyle.nextSibling);
    setupNodePositionWatcher(inlineStyle, 'inline');

    const overrideStyle = createOrUpdateStyle('darkreader--override');
    overrideStyle.textContent = fixes && fixes.css ? replaceCSSTemplates(fixes.css) : '';
    document.head.appendChild(overrideStyle);
    setupNodePositionWatcher(overrideStyle, 'override');

    const variableStyle = createOrUpdateStyle('darkreader--variables');
    const selectionColors = getSelectionColor(filter);
    const {darkSchemeBackgroundColor, darkSchemeTextColor, lightSchemeBackgroundColor, lightSchemeTextColor, mode} = filter;
    let schemeBackgroundColor = mode === 0 ? lightSchemeBackgroundColor : darkSchemeBackgroundColor;
    let schemeTextColor = mode === 0 ? lightSchemeTextColor : darkSchemeTextColor;
    schemeBackgroundColor = modifyBackgroundColor(parse(schemeBackgroundColor), filter);
    schemeTextColor = modifyForegroundColor(parse(schemeTextColor), filter);
    variableStyle.textContent = [
        `:root {`,
        `   --darkreader-neutral-background: ${schemeBackgroundColor};`,
        `   --darkreader-neutral-text: ${schemeTextColor};`,
        `   --darkreader-selection-background: ${selectionColors.backgroundColorSelection};`,
        `   --darkreader-selection-text: ${selectionColors.foregroundColorSelection};`,
        `}`
    ].join('\n');
    document.head.insertBefore(variableStyle, inlineStyle.nextSibling);
    setupNodePositionWatcher(variableStyle, 'variables');

    const proxyScript = createOrUpdateScript('darkreader--proxy');
    proxyScript.textContent = `(${injectProxy})()`;
    document.head.insertBefore(proxyScript, variableStyle.nextSibling);
}

const shadowRootsWithOverrides = new Set<ShadowRoot>();

function createShadowStaticStyleOverrides(root: ShadowRoot) {
    const inlineStyle = createOrUpdateStyle('darkreader--inline', root);
    inlineStyle.textContent = getInlineOverrideStyle();
    root.insertBefore(inlineStyle, root.firstChild);
    const overrideStyle = createOrUpdateStyle('darkreader--override', root);
    overrideStyle.textContent = fixes && fixes.css ? replaceCSSTemplates(fixes.css) : '';
    root.insertBefore(overrideStyle, inlineStyle.nextSibling);
    shadowRootsWithOverrides.add(root);
}

function replaceCSSTemplates($cssText: string) {
    return $cssText.replace(/\${(.+?)}/g, (m0, $color) => {
        try {
            const color = parseColorWithCache($color);
            return modifyColor(color, filter);
        } catch (err) {
            logWarn(err);
            return $color;
        }
    });
}

function cleanFallbackStyle() {
    const fallback = document.querySelector('.darkreader--fallback');
    if (fallback) {
        fallback.textContent = '';
    }
}

function getIgnoreImageAnalysisSelectors() {
    return fixes && Array.isArray(fixes.ignoreImageAnalysis) ? fixes.ignoreImageAnalysis : [];
}

function createDynamicStyleOverrides() {
    cancelRendering();

    updateVariables(getElementCSSVariables(document.documentElement));

    const allStyles = getManageableStyles(document);

    const newManagers = allStyles
        .filter((style) => !styleManagers.has(style))
        .map((style) => createManager(style));
    const newVariables = newManagers
        .map((manager) => manager.details())
        .filter((details) => details && details.variables.size > 0)
        .map(({variables}) => variables);
    if (newVariables.length === 0) {
        styleManagers.forEach((manager) => manager.render(filter, variables, getIgnoreImageAnalysisSelectors()));
        if (loadingStyles.size === 0) {
            cleanFallbackStyle();
        }
    } else {
        newVariables.forEach((variables) => updateVariables(variables));
        throttledRenderAllStyles(() => {
            if (loadingStyles.size === 0) {
                cleanFallbackStyle();
            }
        });
    }
    newManagers.forEach((manager) => manager.watch());

    const inlineStyleElements = toArray(document.querySelectorAll(INLINE_STYLE_SELECTOR));
    iterateShadowHosts(document.documentElement, (host) => {
        createShadowStaticStyleOverrides(host.shadowRoot);
        const elements = host.shadowRoot.querySelectorAll(INLINE_STYLE_SELECTOR);
        if (elements.length > 0) {
            push(inlineStyleElements, elements);
        }
    });
    const ignoredInlineSelectors = fixes && Array.isArray(fixes.ignoreInlineStyle) ? fixes.ignoreInlineStyle : [];
    inlineStyleElements.forEach((el) => overrideInlineStyle(el as HTMLElement, filter, ignoredInlineSelectors, getIgnoreImageAnalysisSelectors()));
    handleAdoptedStyleSheets(document);
}

let loadingStylesCounter = 0;
const loadingStyles = new Set();

function createManager(element: StyleElement) {
    const loadingStyleId = ++loadingStylesCounter;

    function loadingStart() {
        if (!isDOMReady() || !didDocumentShowUp) {
            loadingStyles.add(loadingStyleId);

            const fallbackStyle = document.querySelector('.darkreader--fallback');
            if (!fallbackStyle.textContent) {
                fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: false});
            }
        }
    }

    function loadingEnd() {
        loadingStyles.delete(loadingStyleId);
        if (loadingStyles.size === 0 && isDOMReady()) {
            cleanFallbackStyle();
        }
    }

    function update() {
        const details = manager.details();
        if (!details) {
            return;
        }
        if (details.variables.size === 0) {
            manager.render(filter, variables, getIgnoreImageAnalysisSelectors());
        } else {
            updateVariables(details.variables);
            throttledRenderAllStyles();
        }
    }

    const manager = manageStyle(element, {update, loadingStart, loadingEnd});
    styleManagers.set(element, manager);

    return manager;
}

function updateVariables(newVars: Map<string, string>) {
    if (newVars.size === 0) {
        return;
    }
    newVars.forEach((value, key) => {
        variables.set(key, value);
    });
    variables.forEach((value, key) => {
        variables.set(key, replaceCSSVariables(value, variables));
    });
}

function removeManager(element: StyleElement) {
    const manager = styleManagers.get(element);
    if (manager) {
        manager.destroy();
        styleManagers.delete(element);
    }
}

const throttledRenderAllStyles = throttle((callback?: () => void) => {
    styleManagers.forEach((manager) => manager.render(filter, variables, getIgnoreImageAnalysisSelectors()));
    adoptedStyleManagers.forEach((manager) => manager.render(filter, variables, getIgnoreImageAnalysisSelectors()));
    callback && callback();
});

const cancelRendering = function () {
    throttledRenderAllStyles.cancel();
};

function onDOMReady() {
    if (loadingStyles.size === 0) {
        cleanFallbackStyle();
    }
}

let documentVisibilityListener: () => void = null;
let didDocumentShowUp = !document.hidden;

function watchForDocumentVisibility(callback: () => void) {
    const alreadyWatching = Boolean(documentVisibilityListener);
    documentVisibilityListener = () => {
        if (!document.hidden) {
            stopWatchingForDocumentVisibility();
            callback();
            didDocumentShowUp = true;
        }
    };
    if (!alreadyWatching) {
        document.addEventListener('visibilitychange', documentVisibilityListener);
    }
}

function stopWatchingForDocumentVisibility() {
    document.removeEventListener('visibilitychange', documentVisibilityListener);
    documentVisibilityListener = null;
}

function createThemeAndWatchForUpdates() {
    createStaticStyleOverrides();

    function runDynamicStyle() {
        createDynamicStyleOverrides();
        watchForUpdates();
    }

    if (document.hidden) {
        watchForDocumentVisibility(runDynamicStyle);
    } else {
        runDynamicStyle();
    }

    changeMetaThemeColorWhenAvailable(filter);
}

function handleAdoptedStyleSheets(node: ShadowRoot | Document) {
    if (Array.isArray(node.adoptedStyleSheets)) {
        if (node.adoptedStyleSheets.length > 0) {
            const newManger = createAdoptedStyleSheetOverride(node);

            adoptedStyleManagers.push(newManger);
            newManger.render(filter, variables, getIgnoreImageAnalysisSelectors());
        }
    }
}

function watchForUpdates() {
    const managedStyles = Array.from(styleManagers.keys());
    watchForStyleChanges(managedStyles, ({created, updated, removed, moved}) => {
        const stylesToRemove = removed;
        const stylesToManage = created.concat(updated).concat(moved)
            .filter((style) => !styleManagers.has(style));
        const stylesToRestore = moved
            .filter((style) => styleManagers.has(style));
        stylesToRemove.forEach((style) => removeManager(style));
        const newManagers = stylesToManage
            .map((style) => createManager(style));
        const newVariables = newManagers
            .map((manager) => manager.details())
            .filter((details) => details && details.variables.size > 0)
            .map(({variables}) => variables);
        if (newVariables.length === 0) {
            newManagers.forEach((manager) => manager.render(filter, variables, getIgnoreImageAnalysisSelectors()));
        } else {
            newVariables.forEach((variables) => updateVariables(variables));
            throttledRenderAllStyles();
        }
        newManagers.forEach((manager) => manager.watch());
        stylesToRestore.forEach((style) => styleManagers.get(style).restore());
    }, (shadowRoot) => {
        createShadowStaticStyleOverrides(shadowRoot);
        handleAdoptedStyleSheets(shadowRoot);
    });

    const ignoredInlineSelectors = fixes && Array.isArray(fixes.ignoreInlineStyle) ? fixes.ignoreInlineStyle : [];
    watchForInlineStyles((element) => {
        overrideInlineStyle(element, filter, ignoredInlineSelectors, getIgnoreImageAnalysisSelectors());
        if (element === document.documentElement) {
            const rootVariables = getElementCSSVariables(document.documentElement);
            if (rootVariables.size > 0) {
                updateVariables(rootVariables);
                throttledRenderAllStyles();
            }
        }
    }, (root) => {
        createShadowStaticStyleOverrides(root);
        const inlineStyleElements = root.querySelectorAll(INLINE_STYLE_SELECTOR);
        if (inlineStyleElements.length > 0) {
            forEach(inlineStyleElements, (el) => overrideInlineStyle(el as HTMLElement, filter, ignoredInlineSelectors, getIgnoreImageAnalysisSelectors()));
        }
    });

    addDOMReadyListener(onDOMReady);
}

function stopWatchingForUpdates() {
    styleManagers.forEach((manager) => manager.pause());
    stopStylePositionWatchers();
    stopWatchingForStyleChanges();
    stopWatchingForInlineStyles();
    removeDOMReadyListener(onDOMReady);
}

function createDarkReaderInstanceMarker() {
    const metaElement: HTMLMetaElement = document.createElement('meta');
    metaElement.name = 'darkreader';
    metaElement.content = INSTANCE_ID;
    document.head.appendChild(metaElement);
}

function isAnotherDarkReaderInstanceActive() {
    const meta: HTMLMetaElement = document.querySelector('meta[name="darkreader"]');
    if (meta) {
        if (meta.content !== INSTANCE_ID) {
            return true;
        }
        return false;
    } else {
        createDarkReaderInstanceMarker();
        return false;
    }
}

export function createOrUpdateDynamicTheme(filterConfig: FilterConfig, dynamicThemeFixes: DynamicThemeFix, iframe: boolean) {
    filter = filterConfig;
    fixes = dynamicThemeFixes;
    isIFrame = iframe;
    if (document.head) {
        if (isAnotherDarkReaderInstanceActive()) {
            return;
        }
        createThemeAndWatchForUpdates();
    } else {
        if (!isFirefox) {
            const fallbackStyle = createOrUpdateStyle('darkreader--fallback');
            document.documentElement.appendChild(fallbackStyle);
            fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: true});
        }

        const headObserver = new MutationObserver(() => {
            if (document.head) {
                headObserver.disconnect();
                if (isAnotherDarkReaderInstanceActive()) {
                    removeDynamicTheme();
                    return;
                }
                createThemeAndWatchForUpdates();
            }
        });
        headObserver.observe(document, {childList: true, subtree: true});
    }
}

function removeProxy() {
    document.dispatchEvent(new CustomEvent('__darkreader__cleanUp'));
    removeNode(document.head.querySelector('.darkreader--proxy'));
}

export function removeDynamicTheme() {
    cleanDynamicThemeCache();
    removeNode(document.querySelector('.darkreader--fallback'));
    if (document.head) {
        restoreMetaThemeColor();
        removeNode(document.head.querySelector('.darkreader--user-agent'));
        removeNode(document.head.querySelector('.darkreader--text'));
        removeNode(document.head.querySelector('.darkreader--invert'));
        removeNode(document.head.querySelector('.darkreader--inline'));
        removeNode(document.head.querySelector('.darkreader--override'));
        removeNode(document.head.querySelector('meta[name="darkreader"]'));
        removeProxy();
    }
    shadowRootsWithOverrides.forEach((root) => {
        removeNode(root.querySelector('.darkreader--inline'));
        removeNode(root.querySelector('.darkreader--override'));
    });
    shadowRootsWithOverrides.clear();
    forEach(styleManagers.keys(), (el) => removeManager(el));
    forEach(document.querySelectorAll('.darkreader'), removeNode);

    adoptedStyleManagers.forEach((manager) => {
        manager.destroy();
    });
    adoptedStyleManagers.splice(0);
    parsedURLCache.clear();
}

export function cleanDynamicThemeCache() {
    variables.clear();
    stopWatchingForDocumentVisibility();
    cancelRendering();
    stopWatchingForUpdates();
    cleanModificationCache();
}
