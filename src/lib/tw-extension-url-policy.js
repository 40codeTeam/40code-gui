const TURBOWARP_EXTENSION_ORIGIN = 'https://extensions.turbowarp.org';

const extensionsTrustedByUser = new Set();

const manuallyTrustExtension = url => {
    extensionsTrustedByUser.add(String(url));
};

const parseURL = url => {
    try {
        return new URL(String(url));
    } catch (e) {
        return null;
    }
};

const normalizeOrigin = value => {
    if (!value) return null;
    const text = String(value)
        .trim()
        .replace(/\/+$/, '');
    if (!text) return null;

    const candidates = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ?
        [text] :
        [`https://${text}`, `http://${text}`];

    for (const candidate of candidates) {
        const parsed = parseURL(candidate);
        if (parsed) return parsed.origin;
    }
    return null;
};

const getScratchHostOrigin = () => {
    if (typeof window === 'undefined') return null;
    return normalizeOrigin(window.scratchhost);
};

const isLocalhost = hostname => {
    const normalized = String(hostname || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

const isAllowedRemoteExtensionURL = url => {
    const parsed = parseURL(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return false;
    }

    if (parsed.origin === TURBOWARP_EXTENSION_ORIGIN) return true;
    if (isLocalhost(parsed.hostname)) return true;

    const scratchHostOrigin = getScratchHostOrigin();
    return !!scratchHostOrigin && parsed.origin === scratchHostOrigin;
};

const isTrustedExtension = url => {
    const parsed = parseURL(url);
    if (!parsed) return false;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return isAllowedRemoteExtensionURL(url);
    }
    return extensionsTrustedByUser.has(String(url));
};

const isAllowedExtensionURL = url => {
    const parsed = parseURL(url);
    if (!parsed) {
        // Non-URL values are VM builtin extension IDs; let the VM decide whether they exist.
        return true;
    }
    return isTrustedExtension(url);
};

const getBlockedExtensionURLMessage = url => (
    `Extension URL is not allowed. Only TurboWarp, 40code, and localhost extension URLs can be loaded: ${url}`
);

const assertAllowedExtensionURL = url => {
    if (!isAllowedExtensionURL(url)) {
        throw new Error(getBlockedExtensionURLMessage(url));
    }
};

const installExtensionURLPolicy = vmOrExtensionManager => {
    const extensionManager = vmOrExtensionManager && (
        vmOrExtensionManager.extensionManager || vmOrExtensionManager
    );
    if (!extensionManager || extensionManager.__twExtensionURLPolicyInstalled) return;

    const originalLoadExtensionURL = extensionManager.loadExtensionURL.bind(extensionManager);
    extensionManager.loadExtensionURL = extensionURL => {
        try {
            assertAllowedExtensionURL(extensionURL);
        } catch (error) {
            return Promise.reject(error);
        }
        return originalLoadExtensionURL(extensionURL);
    };
    extensionManager.__twExtensionURLPolicyInstalled = true;
};

export {
    assertAllowedExtensionURL,
    getBlockedExtensionURLMessage,
    installExtensionURLPolicy,
    isAllowedExtensionURL,
    isAllowedRemoteExtensionURL,
    isTrustedExtension,
    manuallyTrustExtension
};
