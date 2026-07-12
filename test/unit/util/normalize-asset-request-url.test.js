import normalizeAssetRequestUrl from '../../../src/lib/normalize-asset-request-url';

describe('normalizeAssetRequestUrl', () => {
    test('replaces MP3 request path suffixes with WAV', () => {
        expect(normalizeAssetRequestUrl('https://assets.example/abc.mp3'))
            .toBe('https://assets.example/abc.wav');
        expect(normalizeAssetRequestUrl('https://assets.example/abc.MP3?token=file.mp3#preview'))
            .toBe('https://assets.example/abc.wav?token=file.mp3#preview');
    });

    test('does not rewrite non-path suffixes', () => {
        expect(normalizeAssetRequestUrl('https://assets.example/abc.wav?source=file.mp3'))
            .toBe('https://assets.example/abc.wav?source=file.mp3');
        expect(normalizeAssetRequestUrl('https://assets.example/abc.mp3/metadata'))
            .toBe('https://assets.example/abc.mp3/metadata');
    });
});
