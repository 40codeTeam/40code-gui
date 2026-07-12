const normalizeAssetRequestUrl = value => {
    const url = String(value || '');
    const suffixIndex = url.search(/[?#]/);
    const path = suffixIndex === -1 ? url : url.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : url.slice(suffixIndex);
    return `${path.replace(/\.mp3$/i, '.wav')}${suffix}`;
};

export default normalizeAssetRequestUrl;
