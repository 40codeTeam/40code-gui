import bindAll from 'lodash.bindall';
import PropTypes from 'prop-types';
import React from 'react';
import VM from 'scratch-vm';
import { defineMessages, injectIntl, intlShape } from 'react-intl';
import log from '../lib/log';

import extensionLibraryContent, {
    galleryError,
    galleryLoading,
    galleryMore
} from '../lib/libraries/extensions/index.jsx';
import extensionTags from '../lib/libraries/tw-extension-tags';

import LibraryComponent from '../components/library/library.jsx';
import extensionIcon from '../components/action-menu/icon--sprite.svg';

const messages = defineMessages({
    extensionTitle: {
        defaultMessage: 'Choose an Extension',
        description: 'Heading for the extension library',
        id: 'gui.extensionLibrary.chooseAnExtension'
    }
});

const toLibraryItem = extension => {
    if (typeof extension === 'object') {
        return ({
            rawURL: extension.iconURL || extensionIcon,
            ...extension
        });
    }
    return extension;
};

const translateGalleryItem = (extension, locale) => ({
    ...extension,
    name: extension.nameTranslations[locale] || extension.name,
    description: extension.descriptionTranslations[locale] || extension.description
});

let cachedGallery = null;

const fetchLibraryWithType = async (type = 'tw') => {
    let url
    if (type == 'tw')
        url = 'https://extensions.turbowarp.org/generated-metadata/extensions-v0.json'
    else
        url = window.apihost + 'work/ext'
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`HTTP status ${res.status}`);
    }
    let data = await res.json();
    if (type == 'tw')
        data = data.extensions
    return data.map(extension => ({
        name: extension.name,
        nameTranslations: extension.nameTranslations || {},
        description: extension.description,
        descriptionTranslations: extension.descriptionTranslations || {},
        extensionId: type == 'tw' ?extension.id:extension.extId,
        extensionURL: type == 'tw' ? `https://extensions.turbowarp.org/${extension.slug}.js` :`${window.scratchhost}/ext/${extension.extId}.js`,
        iconURL: type == 'tw' ? `https://extensions.turbowarp.org/${extension.image || 'images/unknown.svg'}` : (extension.image || 'images/unknown.svg'),
        tags: [type],
        credits: [
            ...(extension.by || []),
            ...(extension.original || []),
            {name:extension.author}
        ].map(credit => {
            if (credit.link) {
                return (
                    <a
                        href={credit.link}
                        target="_blank"
                        rel="noreferrer"
                        key={credit.name}
                    >
                        {credit.name}
                    </a>
                );
            }
            return credit.name;
        }),
        docsURI: extension.docs ? `https://extensions.turbowarp.org/${extension.slug}` : null,
        samples: extension.samples ? extension.samples.map(sample => ({
            href: `${process.env.ROOT}editor?project_url=https://extensions.turbowarp.org/samples/${encodeURIComponent(sample)}.sb3`,
            text: sample
        })) : null,
        incompatibleWithScratch: true,
        featured: true
    }));
};
function removeDuplicatesByKey(arr, key) {
    const seen = new Map();
    return arr.filter(item => {
        if (!item.hasOwnProperty(key)) return false; // 如果没有指定的键，直接过滤掉

        const keyValue = item[key];
        if (seen.has(keyValue)) {
            return false; // 如果这个键值已经出现过，则过滤掉
        } else {
            seen.set(keyValue, true); // 否则添加到 Map 中
            return true; // 保留这个项
        }
    });
}
function addSpacesToValues(arr) {
    const seen = {};

    return arr.map(obj => {
        const newObj = { ...obj };
        
        if (newObj.name) {
            if (!seen[newObj.name]) {
                seen[newObj.name] = 0;
            } else {
                seen[newObj.name] += 1;
                newObj.name += ' '.repeat(seen[newObj.name]);
            }
        }
        
        return newObj;
    });
}

const fetchLibrary = async () => {
    // return await fetchLibraryWithType('tw')
    let data=addSpacesToValues(removeDuplicatesByKey([...(await fetchLibraryWithType('40code')), ...(await fetchLibraryWithType('tw'))],'extensionId'))
    console.log(data)
    return data
}

class ExtensionLibrary extends React.PureComponent {
    constructor(props) {
        super(props);
        bindAll(this, [
            'handleItemSelect'
        ]);
        this.state = {
            gallery: cachedGallery,
            galleryError: null,
            galleryTimedOut: false
        };
    }
    componentDidMount() {
        if (!this.state.gallery) {
            const timeout = setTimeout(() => {
                this.setState({
                    galleryTimedOut: true
                });
            }, 750);

            fetchLibrary()
                .then(gallery => {
                    cachedGallery = gallery;
                    this.setState({
                        gallery
                    });
                    clearTimeout(timeout);
                })
                .catch(error => {
                    log.error(error);
                    this.setState({
                        galleryError: error
                    });
                    clearTimeout(timeout);
                });
        }
    }
    handleItemSelect(item) {
        if (item.href) {
            return;
        }

        const extensionId = item.extensionId;

        if (extensionId === 'custom_extension') {
            this.props.onOpenCustomExtensionModal();
            return;
        }

        if (extensionId === 'procedures_enable_return') {
            this.props.onEnableProcedureReturns();
            this.props.onCategorySelected('myBlocks');
            return;
        }

        const url = item.extensionURL ? item.extensionURL : extensionId;
        if (!item.disabled) {
            if (this.props.vm.extensionManager.isExtensionLoaded(extensionId)) {
                this.props.onCategorySelected(extensionId);
            } else {
                this.props.vm.extensionManager.loadExtensionURL(url)
                    .then(() => {
                        this.props.onCategorySelected(extensionId);
                    })
                    .catch(err => {
                        log.error(err);
                        // eslint-disable-next-line no-alert
                        alert(err);
                    });
            }
        }
    }
    render() {
        let library = null;
        if (this.state.gallery || this.state.galleryError || this.state.galleryTimedOut) {
            library = extensionLibraryContent.map(toLibraryItem);
            library.push('---');
            if (this.state.gallery) {
                library.push(toLibraryItem(galleryMore));
                const locale = this.props.intl.locale;
                try {
                    library.push(
                        ...this.state.gallery
                            .map(i => translateGalleryItem(i, locale))
                            .map(toLibraryItem)
                    );
                } catch (error) {
                    console.log(this.state.gallery)
                    console.error(error)
                }
                
            } else if (this.state.galleryError) {
                library.push(toLibraryItem(galleryError));
            } else {
                library.push(toLibraryItem(galleryLoading));
            }
        }

        return (
            <LibraryComponent
                data={library}
                filterable
                persistableKey="extensionId"
                id="extensionLibrary"
                tags={extensionTags}
                title={this.props.intl.formatMessage(messages.extensionTitle)}
                visible={this.props.visible}
                onItemSelected={this.handleItemSelect}
                onRequestClose={this.props.onRequestClose}
            />
        );
    }
}

ExtensionLibrary.propTypes = {
    intl: intlShape.isRequired,
    onCategorySelected: PropTypes.func,
    onEnableProcedureReturns: PropTypes.func,
    onOpenCustomExtensionModal: PropTypes.func,
    onRequestClose: PropTypes.func,
    visible: PropTypes.bool,
    vm: PropTypes.instanceOf(VM).isRequired // eslint-disable-line react/no-unused-prop-types
};

export default injectIntl(ExtensionLibrary);
